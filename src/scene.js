/*global Scene */
import {Geo} from './geo';
import Utils from './utils';
import WorkerBroker from './worker_broker';
import {GL} from './gl/gl';
import {GLBuilders} from './gl/gl_builders';
import GLProgram from './gl/gl_program';
import GLTexture from './gl/gl_texture';
import {StyleManager} from './style';
import Camera from './camera';
import Lighting from './light';
import Tile from './tile';
import TileSource from './tile_source';

import log from 'loglevel';
import glMatrix from 'gl-matrix';
var mat4 = glMatrix.mat4;
var vec3 = glMatrix.vec3;

// Global setup
Utils.inMainThread(() => {
    // On main thread only (skip in web worker)
    Utils.requestAnimationFramePolyfill();
 });
Scene.tile_scale = 4096; // coordinates are locally scaled to the range [0, tile_scale]
Geo.setTileScale(Scene.tile_scale);
GLBuilders.setTileScale(Scene.tile_scale);
GLProgram.defines.TILE_SCALE = Scene.tile_scale;

// Load scene definition: pass an object directly, or a URL as string to load remotely
export default function Scene(tile_source, config_source, options) {

    options = options || {};
    this.initialized = false;

    this.tile_source = tile_source;
    this.tiles = {};
    this.queued_tiles = [];
    this.num_workers = options.numWorkers || 2;
    this.allow_cross_domain_workers = (options.allowCrossDomainWorkers === false ? false : true);
    this.worker_url = options.workerUrl;

    this.config = null;
    this.config_source = config_source;
    this.config_serialized = null;

    this.styles = null;

    this.building = null;                           // tracks current scene building state (tiles being built, etc.)
    this.dirty = true;                              // request a redraw
    this.animated = false;                          // request redraw every frame
    this.preRender = options.preRender;             // optional pre-rendering hook
    this.postRender = options.postRender;           // optional post-rendering hook
    this.render_loop = !options.disableRenderLoop;  // disable render loop - app will have to manually call Scene.render() per frame

    this.frame = 0;
    this.zoom = null;
    this.center = null;
    this.device_pixel_ratio = window.devicePixelRatio || 1;

    this.zooming = false;
    this.panning = false;
    this.logLevel = options.logLevel || 'debug';
    log.setLevel(this.logLevel);

    this.container = options.container;

    this.resetTime();
}

Scene.create = function ({tile_source, config}, options = {}) {
    if (!(tile_source instanceof TileSource)) {
        tile_source = TileSource.create(tile_source);
    }
    return new Scene(tile_source, config, options);
};

Scene.prototype.init = function () {
    if (this.initialized) {
        return Promise.resolve();
    }
    this.initializing = true;

    // Load scene definition (sources, styles, etc.), then create styles & workers
    return new Promise((resolve, reject) => {
        this.loadScene().then(() => {
            Promise.all([
                new Promise((resolve, reject) => {
                    this.styles = StyleManager.createStyles(this.config.styles);
                    this.updateActiveStyles();
                    resolve();
                }),
                this.createWorkers()
            ]).then(() => {
                this.container = this.container || document.body;
                this.canvas = document.createElement('canvas');
                this.canvas.style.position = 'absolute';
                this.canvas.style.top = 0;
                this.canvas.style.left = 0;
                this.canvas.style.zIndex = -1;
                this.container.appendChild(this.canvas);

                this.gl = GL.getContext(this.canvas);
                this.resizeMap(this.container.clientWidth, this.container.clientHeight);

                // this.zoom_step = 0.02; // for fractional zoom user adjustment
                this.last_render_count = null;
                this.initInputHandlers();

                this.createCamera();
                this.createLighting();
                this.initSelectionBuffer();

                // Init GL context for styles
                for (var style of Utils.values(this.styles)) {
                    style.setGL(this.gl);
                }
                this.updateStyles();

                this.initializing = false;
                this.initialized = true;
                resolve();

                if (this.render_loop !== false) {
                    this.setupRenderLoop();
                }
            }, reject);
        });
    });
};

Scene.prototype.destroy = function () {
    this.initialized = false;
    this.renderLoop = () => {}; // set to no-op because a null can cause requestAnimationFrame to throw

    if (this.canvas && this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
    }
    this.container = null;

    if (this.gl) {
        this.gl.deleteFramebuffer(this.fbo);
        this.fbo = null;

        GLTexture.destroy(this.gl);
        StyleManager.destroy(this.gl);
        this.styles = {};

        this.gl = null;
    }

    if (Array.isArray(this.workers)) {
        this.workers.forEach((worker) => {
            worker.terminate();
        });
        this.workers = null;
    }

    this.tiles = {}; // TODO: probably destroy each tile separately too
};

Scene.prototype.initSelectionBuffer = function () {
    // Selection state tracking
    this.pixel = new Uint8Array(4);
    this.pixel32 = new Float32Array(this.pixel.buffer);
    this.selection_requests = {};
    this.selected_feature = null;
    this.selection_delay_timer = null;
    this.selection_frame_delay = 5; // delay from selection render to framebuffer sample, to avoid CPU/GPU sync lock

    // Frame buffer for selection
    // TODO: initiate lazily in case we don't need to do any selection
    this.fbo = this.gl.createFramebuffer();
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.fbo_size = { width: 256, height: 256 }; // TODO: make configurable / adaptive based on canvas size
    this.fbo_size.aspect = this.fbo_size.width / this.fbo_size.height;
    this.gl.viewport(0, 0, this.fbo_size.width, this.fbo_size.height);

    // Texture for the FBO color attachment
    var fbo_texture = new GLTexture(this.gl, 'selection_fbo');
    fbo_texture.setData(this.fbo_size.width, this.fbo_size.height, null, { filtering: 'nearest' });
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, fbo_texture.texture, 0);

    // Renderbuffer for the FBO depth attachment
    var fbo_depth_rb = this.gl.createRenderbuffer();
    this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, fbo_depth_rb);
    this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.DEPTH_COMPONENT16, this.fbo_size.width, this.fbo_size.height);
    this.gl.framebufferRenderbuffer(this.gl.FRAMEBUFFER, this.gl.DEPTH_ATTACHMENT, this.gl.RENDERBUFFER, fbo_depth_rb);

    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
};

Scene.prototype.createObjectURL = function () {
    return (window.URL && window.URL.createObjectURL) || (window.webkitURL && window.webkitURL.createObjectURL);
};

// Web workers handle heavy duty tile construction: networking, geometry processing, etc.
Scene.prototype.createWorkers = function () {
    return new Promise((resolve, reject) => {
        var worker_url = this.worker_url || Utils.findCurrentURL('tangram.debug.js', 'tangram.min.js');
        if (!worker_url) {
            reject(new Error("Can't load worker because couldn't find base URL that library was loaded from"));
            return;
        }

        var createObjectURL = this.createObjectURL();
        if (createObjectURL && this.allow_cross_domain_workers) {
            // To allow workers to be loaded cross-domain, first load worker source via XHR, then create a local URL via a blob
            Utils.io(worker_url).then((body) => {
                if (body.length === 0) {
                    reject(new Error('Web worker loaded with content length zero'));
                }
                var worker_local_url = createObjectURL(new Blob([body], { type: 'application/javascript' }));
                this.makeWorkers(worker_local_url).then(resolve, reject);
            }, reject);
        } else { // Traditional load from remote URL
            this.makeWorkers(worker_url).then(resolve, reject);
        }
    });
};

// Instantiate workers from URL, init event handlers
Scene.prototype.makeWorkers = function (url) {
    var queue = [];

    this.workers = [];
    for (var id=0; id < this.num_workers; id++) {
        var worker = new Worker(url);
        this.workers[id] = worker;

        worker.addEventListener('message', this.workerLogMessage.bind(this));
        WorkerBroker.addWorker(worker);

        log.debug(`Scene.makeWorkers: initializing worker ${id}`);
        let _id = id;
        queue.push(WorkerBroker.postMessage(worker, 'init', id).then(
            (id) => {
                log.debug(`Scene.makeWorkers: initialized worker ${id}`);
                return id;
            },
            (error) => {
                log.error(`Scene.makeWorkers: failed to initialize worker ${_id}:`, error);
                return Promise.reject(error);
            })
        );
    }

    this.next_worker = 0;
    this.selection_map_worker_size = {};

    return Promise.all(queue);
};

// Round robin selection of next worker
Scene.prototype.nextWorker = function () {
    var worker = this.workers[this.next_worker];
    this.next_worker = (this.next_worker + 1) % this.workers.length;
    return worker;
};

Scene.prototype.setCenter = function (lng, lat, zoom) {
    this.center = { lng, lat };
    if (zoom) {
        this.setZoom(zoom);
    }
    this.updateBounds();
};

Scene.prototype.startZoom = function () {
    this.last_zoom = this.zoom;
    this.zooming = true;
};

Scene.prototype.preserve_tiles_within_zoom = 2;
Scene.prototype.setZoom = function (zoom) {
    // Schedule GL tiles for removal on zoom
    var below = zoom;
    var above = zoom;
    if (this.last_zoom != null) {
        log.trace(`scene.last_zoom: ${this.last_zoom}`);
        if (Math.abs(zoom - this.last_zoom) <= this.preserve_tiles_within_zoom) {
            if (zoom > this.last_zoom) {
                below = zoom - this.preserve_tiles_within_zoom;
            }
            else {
                above = zoom + this.preserve_tiles_within_zoom;
            }
        }
    }

    this.last_zoom = this.zoom;
    this.zoom = zoom;
    this.capped_zoom = Math.min(~~this.zoom, this.tile_source.max_zoom || ~~this.zoom);
    this.zooming = false;
    this.updateBounds();

    this.removeTilesOutsideZoomRange(below, above);
};

Scene.prototype.viewReady = function () {
    if (this.css_size == null || this.center == null || this.zoom == null) {
         return false;
    }
    return true;
};

// Calculate viewport bounds based on current center and zoom
Scene.prototype.updateBounds = function () {
    // TODO: better concept of "readiness" state?
    if (!this.viewReady()) {
        return;
    }

    this.meters_per_pixel = Geo.metersPerPixel(this.zoom);

    // Size of the half-viewport in meters at current zoom
    this.meter_zoom = {
        x: this.css_size.width / 2 * this.meters_per_pixel,
        y: this.css_size.height / 2 * this.meters_per_pixel
    };

    // Center of viewport in meters
    var [x, y] = Geo.latLngToMeters([this.center.lng, this.center.lat]);
    this.center_meters = { x, y };

    this.bounds_meters = {
        sw: {
            x: this.center_meters.x - this.meter_zoom.x,
            y: this.center_meters.y - this.meter_zoom.y
        },
        ne: {
            x: this.center_meters.x + this.meter_zoom.x,
            y: this.center_meters.y + this.meter_zoom.y
        }
    };

    // Buffered meter bounds catches objects outside viewport that stick into view space
    // TODO: this is a hacky solution, need to revisit
    var buffer = 200 * this.meters_per_pixel; // pixels -> meters
    this.bounds_meters_buffered = {
        sw: {
            x: this.bounds_meters.sw.x - buffer,
            y: this.bounds_meters.sw.y - buffer
        },
        ne: {
            x: this.bounds_meters.ne.x + buffer,
            y: this.bounds_meters.ne.y + buffer
        }
    };

    // Mark tiles as visible/invisible
    for (var tile of Utils.values(this.tiles)) {
        tile.updateVisibility(this);
    }

    this.dirty = true;
};

Scene.prototype.removeTilesOutsideZoomRange = function (below, above) {
    below = Math.min(below, this.tile_source.max_zoom || below);
    above = Math.min(above, this.tile_source.max_zoom || above);

    var remove_tiles = [];
    for (var t in this.tiles) {
        var tile = this.tiles[t];
        if (tile.coords.z < below || tile.coords.z > above) {
            remove_tiles.push(t);
        }
    }
    for (var r=0; r < remove_tiles.length; r++) {
        var key = remove_tiles[r];
        log.debug(`removed ${key} (outside range [${below}, ${above}])`);
        this.removeTile(key);
    }
};

Scene.prototype.resizeMap = function (width, height) {
    this.dirty = true;

    this.css_size = { width: width, height: height };
    this.device_size = { width: Math.round(this.css_size.width * this.device_pixel_ratio), height: Math.round(this.css_size.height * this.device_pixel_ratio) };
    this.view_aspect = this.css_size.width / this.css_size.height;
    this.updateBounds();

    if (this.canvas) {
        this.canvas.style.width = this.css_size.width + 'px';
        this.canvas.style.height = this.css_size.height + 'px';
        this.canvas.width = this.device_size.width;
        this.canvas.height = this.device_size.height;

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
};

// Request scene be redrawn at next animation loop
Scene.prototype.requestRedraw = function () {
    this.dirty = true;
};

// Redraw scene immediately - don't wait for animation loop
// Use sparingly, but for cases where you need the closest possible sync with other UI elements,
// such as other, non-WebGL map layers (e.g. Leaflet raster layers, markers, etc.)
Scene.prototype.immediateRedraw = function () {
    this.dirty = true;
    this.render();
};

// Setup the render loop
Scene.prototype.setupRenderLoop = function ({ pre_render, post_render } = {}) {
    this.renderLoop = () => {
        if (this.initialized) {
            // Render the scene
            this.render();
        }

        // Request the next frame
        window.requestAnimationFrame(this.renderLoop);
    };
    setTimeout(() => { this.renderLoop(); }, 0); // delay start by one tick
};

Scene.prototype.render = function () {
    this.loadQueuedTiles();

    // Render on demand
    if (this.dirty === false || this.initialized === false || this.viewReady() === false) {
        return false;
    }
    this.dirty = false; // subclasses can set this back to true when animation is needed

    // Pre-render hook
    if (typeof this.preRender === 'function') {
        this.preRender();
    }

    // Render the scene
    this.renderGL();

    // Post-render hook
    if (typeof this.postRender === 'function') {
        this.postRender();
    }

    // Redraw every frame if animating
    if (this.animated === true) {
        this.dirty = true;
    }

    this.frame++;
    log.trace('Scene.render()');
    return true;
};

Scene.prototype.resetFrame = function () {
    if (!this.initialized) {
        return;
    }

    // Reset frame state
    var gl = this.gl;
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // TODO: unnecessary repeat?
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    // gl.enable(gl.BLEND);
    // gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
};

Scene.prototype.renderGL = function () {
    var gl = this.gl;

    this.input();
    this.resetFrame();

    // Map transforms
    if (!this.center) {
        return;
    }

    var [x, y] = Geo.latLngToMeters([this.center.lng, this.center.lat]);
    var center = {x, y};

    // Model-view matrices
    var tile_view_mat = mat4.create();
    var tile_world_mat = mat4.create();

    // Update camera & lights
    this.camera.update();
    this.lighting.update();

    // Renderable tile list
    var renderable_tiles = [];
    for (var t in this.tiles) {
        var tile = this.tiles[t];
        if (tile.loaded === true && tile.visible === true) {
            renderable_tiles.push(tile);
        }
    }
    this.renderable_tiles_count = renderable_tiles.length;

    // Render main pass - tiles grouped by rendering style (GL program)
    var render_count = 0;
    for (var style in this.styles) {
        // Per-frame style updates/animations
        // Called even if the style isn't rendered by any current tiles, so time-based animations, etc. continue
        this.styles[style].update();

        var program = this.styles[style].program;
        if (program == null || program.compiled === false) {
            continue;
        }

        var first_for_style = true;

        // Render tile GL geometries
        for (t in renderable_tiles) {
            tile = renderable_tiles[t];

            if (tile.gl_geometry[style] != null) {
                // Setup style if encountering for first time this frame
                // (lazy init, not all styles will be used in all screen views; some styles might be defined but never used)
                if (first_for_style === true) {
                    first_for_style = false;

                    program.use();
                    this.styles[style].setUniforms();

                    // TODO: don't set uniforms when they haven't changed
                    program.uniform('2f', 'u_resolution', this.device_size.width, this.device_size.height);
                    program.uniform('2f', 'u_aspect', this.view_aspect, 1.0);
                    program.uniform('1f', 'u_time', ((+new Date()) - this.start_time) / 1000);
                    program.uniform('1f', 'u_map_zoom', this.zoom); // Math.floor(this.zoom) + (Math.log((this.zoom % 1) + 1) / Math.LN2 // scale fractional zoom by log
                    program.uniform('2f', 'u_map_center', center.x, center.y);
                    program.uniform('1f', 'u_num_layers', Object.keys(this.config.layers).length);
                    program.uniform('1f', 'u_meters_per_pixel', this.meters_per_pixel);

                    this.camera.setupProgram(program);
                    this.lighting.setupProgram(program);
                }

                // TODO: calc these once per tile (currently being needlessly re-calculated per-tile-per-style)

                // Tile origin
                program.uniform('2f', 'u_tile_origin', tile.min.x, tile.min.y);

                // Tile view matrix - transform tile space into view space (meters, relative to camera)
                mat4.identity(tile_view_mat);
                mat4.translate(tile_view_mat, tile_view_mat, vec3.fromValues(tile.min.x - center.x, tile.min.y - center.y, 0)); // adjust for tile origin & map center
                mat4.scale(tile_view_mat, tile_view_mat, vec3.fromValues(tile.span.x / Scene.tile_scale, -1 * tile.span.y / Scene.tile_scale, 1)); // scale tile local coords to meters
                program.uniform('Matrix4fv', 'u_tile_view', false, tile_view_mat);

                // Tile world matrix - transform tile space into world space (meters, absolute mercator position)
                mat4.identity(tile_world_mat);
                mat4.translate(tile_world_mat, tile_world_mat, vec3.fromValues(tile.min.x, tile.min.y, 0));
                mat4.scale(tile_world_mat, tile_world_mat, vec3.fromValues(tile.span.x / Scene.tile_scale, -1 * tile.span.y / Scene.tile_scale, 1)); // scale tile local coords to meters
                program.uniform('Matrix4fv', 'u_tile_world', false, tile_world_mat);

                // Render tile
                tile.gl_geometry[style].render();
                render_count += tile.gl_geometry[style].geometry_count;
            }
        }
    }

    // Render selection pass (if needed)
    // Slight variations on render pass code above - mostly because we're reusing uniforms from the main
    // style program, for the selection program
    // TODO: reduce duplicated code w/main render pass above
    if (Object.keys(this.selection_requests).length > 0) {
        if (this.panning) {
            return;
        }

        // Switch to FBO
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.viewport(0, 0, this.fbo_size.width, this.fbo_size.height);
        this.resetFrame();

        for (style in this.styles) {
            program = this.styles[style].selection_program;
            if (program == null || program.compiled === false) {
                continue;
            }

            first_for_style = true;

            // Render tile GL geometries
            for (t in renderable_tiles) {
                tile = renderable_tiles[t];

                if (tile.gl_geometry[style] != null) {
                    // Setup style if encountering for first time this frame
                    if (first_for_style === true) {
                        first_for_style = false;

                        program.use();
                        this.styles[style].setUniforms();

                        program.uniform('2f', 'u_resolution', this.fbo_size.width, this.fbo_size.height);
                        program.uniform('2f', 'u_aspect', this.fbo_size.aspect, 1.0);
                        program.uniform('1f', 'u_time', ((+new Date()) - this.start_time) / 1000);
                        program.uniform('1f', 'u_map_zoom', this.zoom);
                        program.uniform('2f', 'u_map_center', center.x, center.y);
                        program.uniform('1f', 'u_num_layers', Object.keys(this.config.layers).length);
                        program.uniform('1f', 'u_meters_per_pixel', this.meters_per_pixel);

                        this.camera.setupProgram(program);
                        this.lighting.setupProgram(program);
                    }

                    // Tile origin
                    program.uniform('2f', 'u_tile_origin', tile.min.x, tile.min.y);

                    // Tile view matrix - transform tile space into view space (meters, relative to camera)
                    mat4.identity(tile_view_mat);
                    mat4.translate(tile_view_mat, tile_view_mat, vec3.fromValues(tile.min.x - center.x, tile.min.y - center.y, 0)); // adjust for tile origin & map center
                    mat4.scale(tile_view_mat, tile_view_mat, vec3.fromValues(tile.span.x / Scene.tile_scale, -1 * tile.span.y / Scene.tile_scale, 1)); // scale tile local coords to meters
                    program.uniform('Matrix4fv', 'u_tile_view', false, tile_view_mat);

                    // Tile world matrix - transform tile space into world space (meters, absolute mercator position)
                    mat4.identity(tile_world_mat);
                    mat4.translate(tile_world_mat, tile_world_mat, vec3.fromValues(tile.min.x, tile.min.y, 0));
                    mat4.scale(tile_world_mat, tile_world_mat, vec3.fromValues(tile.span.x / Scene.tile_scale, -1 * tile.span.y / Scene.tile_scale, 1)); // scale tile local coords to meters
                    program.uniform('Matrix4fv', 'u_tile_world', false, tile_world_mat);

                    // Render tile
                    tile.gl_geometry[style].render();
                }
            }
        }

        // Delay reading the pixel result from the selection buffer to avoid CPU/GPU sync lock.
        // Calling readPixels synchronously caused a massive performance hit, presumably since it
        // forced this function to wait for the GPU to finish rendering and retrieve the texture contents.
        if (this.selection_delay_timer != null) {
            clearTimeout(this.selection_delay_timer);
        }
        this.selection_delay_timer = setTimeout(
            () => this.doFeatureSelectionRequests(),
            this.selection_frame_delay
        );

        // Reset to screen buffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    if (render_count !== this.last_render_count) {
        log.info(`Scene: rendered ${render_count} primitives`);
    }
    this.last_render_count = render_count;

    return true;
};

// Request feature selection
// Runs asynchronously, schedules selection buffer to be updated
Scene.prototype.getFeatureAt = function (pixel) {
    return new Promise((resolve, reject) => {
        if (!this.initialized) {
            reject(new Error("Scene.getFeatureAt() called before scene was initialized"));
            return;
        }

        // Queue requests for feature selection, and they will be picked up by the render loop
        this.selection_request_id = (this.selection_request_id + 1) || 0;
        this.selection_requests[this.selection_request_id] = {
            type: 'point',
            id: this.selection_request_id,
            point: {
                // TODO: move this pixel calc to a GL wrapper
                x: pixel.x * this.device_pixel_ratio,
                y: this.device_size.height - (pixel.y * this.device_pixel_ratio)
            },
            resolve
        };
        this.dirty = true; // need to make sure the scene re-renders for these to be processed
    });
};

Scene.prototype.doFeatureSelectionRequests = function () {
    var gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);

    for (var request of Utils.values(this.selection_requests)) {
        // This request was already sent to the worker, we're just awaiting its reply
        if (request.sent) {
            continue;
        }

        // TODO: support other selection types, such as features within a box
        if (request.type !== 'point') {
            continue;
        }

        // Check selection map against FBO
        gl.readPixels(
            Math.floor(request.point.x * this.fbo_size.width / this.device_size.width),
            Math.floor(request.point.y * this.fbo_size.height / this.device_size.height),
            1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
        var feature_key = (this.pixel[0] + (this.pixel[1] << 8) + (this.pixel[2] << 16) + (this.pixel[3] << 24)) >>> 0;

        // If feature found, ask appropriate web worker to lookup feature
        var worker_id = this.pixel[3];
        if (worker_id !== 255) { // 255 indicates an empty selection buffer pixel
            if (this.workers[worker_id] != null) {
                WorkerBroker.postMessage(
                    this.workers[worker_id],
                    'getFeatureSelection',
                    { id: request.id, key: feature_key })
                .then(message => {
                    this.workerGetFeatureSelection(message);
                });
            }
        }
        // No feature found, but still need to resolve promise
        else {
            this.workerGetFeatureSelection({ id: request.id, feature: null });
        }

        request.sent = true;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};

// Called on main thread when a web worker finds a feature in the selection buffer
Scene.prototype.workerGetFeatureSelection = function (message) {
    var request = this.selection_requests[message.id];
    if (!request) {
        throw new Error("Scene.workerGetFeatureSelection() called without any message");
    }

    var feature = message.feature;
    var changed = false;
    if ((feature != null && this.selected_feature == null) ||
        (feature == null && this.selected_feature != null) ||
        (feature != null && this.selected_feature != null && feature.id !== this.selected_feature.id)) {
        changed = true;
    }

    this.selected_feature = feature; // store the most recently selected feature

    // Resolve the request
    request.resolve({ feature, changed, request });
    delete this.selection_requests[message.id]; // done processing this request
};

// Queue a tile for load
Scene.prototype.loadTile = function (...args) {
    this.queued_tiles[this.queued_tiles.length] = args;
};

// Load all queued tiles
Scene.prototype.loadQueuedTiles = function () {
    if (!this.initialized) {
        return;
    }

    if (this.queued_tiles.length === 0) {
        return;
    }

    for (var t=0; t < this.queued_tiles.length; t++) {
        this._loadTile.apply(this, this.queued_tiles[t]);
    }

    this.queued_tiles = [];
};

// tile manager
Scene.prototype.cacheTile = function (tile) {
    this.tiles[tile.key] = tile;
};

Scene.prototype.hasTile = function (key) {
    return this.tiles[key] !== undefined;
};

Scene.prototype.forgetTile = function (key) {
    delete this.tiles[key];
};


// Load a single tile
Scene.prototype._loadTile = function (coords, options = {}) {
    var tile = Tile.create({coords: coords, tile_source: this.tile_source});
    if (!this.hasTile(tile.key)) {
        this.cacheTile(tile);
        tile.load(this, coords);
        if (options.debugElement) {
            tile.updateDebugElement(options.debugElement, this.debug);
        }
    }
    return tile;
};

// TODO: detect which elements need to be refreshed/rebuilt (stylesheet changes, etc.)
Scene.prototype.rebuild = function () {
    return this.rebuildGeometry();
};

// Rebuild all tiles
Scene.prototype.rebuildGeometry = function () {
    if (!this.initialized) {
        return Promise.reject(new Error('Scene.rebuildGeometry: scene is not initialized'));
    }

    return new Promise((resolve, reject) => {
        // Skip rebuild if already in progress
        if (this.building) {
            // Queue up to one rebuild call at a time, only save last request
            if (this.building.queued && this.building.queued.reject) {
                // notify previous request that it did not complete
                this.building.queued.reject(new Error('Scene.rebuildGeometry: request superceded by a newer call'));
            }

            // Save queued request
            this.building.queued = { resolve, reject };
            log.trace(`Scene.rebuildGeometry(): queuing request`);
            return;
        }

        // Track tile build state
        this.building = { resolve, reject, tiles: {} };

        // Update config (in case JS objects were manipulated directly)
        this.config_serialized = Utils.serializeWithFunctions(this.config);
        this.selection_map = {};

        // Tell workers we're about to rebuild (so they can update styles, etc.)
        this.workers.forEach(worker => {
            WorkerBroker.postMessage(worker, 'prepareForRebuild', {
                config: this.config_serialized
            });
        });

        // Rebuild visible tiles first, from center out
        var tile, visible = [], invisible = [];
        for (tile of Utils.values(this.tiles)) {
            if (tile.visible === true) {
                visible.push(tile);
            }
            else {
                invisible.push(tile);
            }
        }

        visible.sort((a, b) => {
            return (b.center_dist > a.center_dist ? -1 : (b.center_dist === a.center_dist ? 0 : 1));
        });

        for (tile of visible) {
            tile.build(this);
        }

        for (tile of invisible) {
            // Keep tiles in current zoom but out of visible range, but rebuild as lower priority
            if (tile.isInZoom(this)) {
                tile.build(this);
            }
            // Drop tiles outside current zoom
            else {
                this.removeTile(tile.key);
            }
        }

        this.updateActiveStyles();
        this.resetTime();

        // Edge case: if nothing is being rebuilt, immediately resolve promise and don't lock further rebuilds
        if (this.building && Object.keys(this.building.tiles).length === 0) {
            resolve();

            // Another rebuild queued?
            var queued = this.building.queued;
            this.building = null;
            if (queued) {
                log.debug(`Scene: starting queued rebuildGeometry() request`);
                this.rebuildGeometry().then(queued.resolve, queued.reject);
            }
        }
    });
};

// TODO: move to Tile class
// Called on main thread when a web worker completes processing for a single tile (initial load, or rebuild)
Scene.prototype.buildTileCompleted = function ({ tile, worker_id, selection_map_size }) {
    // Track selection map size (for stats/debug) - update per worker and sum across workers
    this.selection_map_worker_size[worker_id] = selection_map_size;
    this.selection_map_size = 0;
    for (var wid in this.selection_map_worker_size) {
        this.selection_map_size += this.selection_map_worker_size[wid];
    }

    // Removed this tile during load?
    if (this.tiles[tile.key] == null) {
        log.debug(`discarded tile ${tile.key} in Scene.buildTileCompleted because previously removed`);
    }
    else {
        var cached = this.tiles[tile.key];

        // Update tile with properties from worker
        if (cached) {
            tile = cached.merge(tile);
        }

        if (!tile.error) {
            tile.finalizeGeometry(this.styles);
            this.dirty = true;
        }
        else {
            log.error(`main thread tile load error for ${tile.key}: ${tile.error}`);
        }
        tile.printDebug();
    }

    this.trackTileSetLoadStop();
    this.trackTileBuildStop(tile.key);
};

// Track tile build state
Scene.prototype.trackTileBuildStart = function (key) {
    if (!this.building) {
        this.building = {
            tiles: {}
        };
    }
    this.building.tiles[key] = true;
    log.trace(`trackTileBuildStart for ${key}: ${Object.keys(this.building.tiles).length}`);
};

Scene.prototype.trackTileBuildStop = function (key) {
    // Done building?
    if (this.building) {
        log.trace(`trackTileBuildStop for ${key}: ${Object.keys(this.building.tiles).length}`);
        delete this.building.tiles[key];
        if (Object.keys(this.building.tiles).length === 0) {
            log.info(`Scene: build geometry finished`);
            log.debug(`Scene: updated selection map: ${this.selection_map_size} features`);

            if (this.building.resolve) {
                this.building.resolve();
            }

            // Another rebuild queued?
            var queued = this.building.queued;
            this.building = null;
            if (queued) {
                log.debug(`Scene: starting queued rebuildGeometry() request`);
                this.rebuildGeometry().then(queued.resolve, queued.reject);
            }
        }
    }
};

Scene.prototype.removeTile = function (key)
{
    if (!this.initialized) {
        return;
    }
    log.debug(`tile unload for ${key}`);

    if (this.zooming === true) {
        return; // short circuit tile removal, will sweep out tiles by zoom level when zoom ends
    }

    var tile = this.tiles[key];

    if (tile != null) {
        tile.freeResources();
        tile.remove(this);
    }

    this.forgetTile(tile.key);
    this.dirty = true;
};

/**
   Load (or reload) the scene config
   @return {Promise}
*/
Scene.prototype.loadScene = function () {
    return this.loadConfig(this.config_source);
};

Scene.prototype.loadConfig = function (source) {
    return Utils.loadResource(source).then((config) => {
        this.config = config;
        return StyleManager.preProcessSceneConfig(this.config);
    }).then(() => {
        this.config_serialized = Utils.serializeWithFunctions(this.config);
    });
};

// Reload scene config and rebuild tiles
Scene.prototype.reload = function () {
    if (!this.initialized) {
        return;
    }

    this.loadScene().then(() => {
        this.updateStyles();
        return this.rebuildGeometry();
    }, (error) => {
        throw error;
    });

};

// Called (currently manually) after styles are updated in stylesheet
Scene.prototype.updateStyles = function () {
    if (!this.initialized && !this.initializing) {
        throw new Error('Scene.updateStyles() called before scene was initialized');
    }

    this.styles = StyleManager.updateStyles(this.config.styles);
    this.dirty = true;
};

Scene.prototype.updateActiveStyles = function () {
    // TODO: this would have to walk the whole rule tree collecting all styles to be accurate
    // Make a set of currently active styles (used in a layer)
    this.active_styles = {};
    var animated = false; // is any active style animated?


    for (var l in this.config.layers) {
        var style = this.config.layers[l].style.name;
        if (this.config.layers[l].visible !== false && this.styles[style]) {
            this.active_styles[style] = true;

            // Check if this style is animated
            if (animated === false && this.styles[style].animated === true) {
                animated = true;
            }
        }
    }
    this.animated = animated;
};

// Create camera
Scene.prototype.createCamera = function () {
    this.camera = Camera.create(this, this.config.camera);
};

// Create lighting
Scene.prototype.createLighting = function () {
    this.lighting = Lighting.create(this, this.config.lighting);
};

// Update scene config
Scene.prototype.updateConfig = function () {
    this.createCamera();
    this.createLighting();

    // TODO: detect changes to styles? already (currently) need to recompile anyway when camera or lights change
    this.updateStyles();
};

// Reset internal clock, mostly useful for consistent experience when changing styles/debugging
Scene.prototype.resetTime = function () {
    this.start_time = +new Date();
};

// User input
// TODO: restore fractional zoom support once leaflet animation refactor pull request is merged

Scene.prototype.initInputHandlers = function () {
    // this.key = null;

    // document.addEventListener('keydown', function (event) {
    //     if (event.keyCode == 37) {
    //         this.key = 'left';
    //     }
    //     else if (event.keyCode == 39) {
    //         this.key = 'right';
    //     }
    //     else if (event.keyCode == 38) {
    //         this.key = 'up';
    //     }
    //     else if (event.keyCode == 40) {
    //         this.key = 'down';
    //     }
    //     else if (event.keyCode == 83) { // s
    //     }
    // }.bind(this));

    // document.addEventListener('keyup', function (event) {
    //     this.key = null;
    // }.bind(this));
};

Scene.prototype.input = function () {
    // // Fractional zoom scaling
    // if (this.key == 'up') {
    //     this.setZoom(this.zoom + this.zoom_step);
    // }
    // else if (this.key == 'down') {
    //     this.setZoom(this.zoom - this.zoom_step);
    // }
};


// Stats/debug/profiling methods

// Profiling methods used to track when sets of tiles start/stop loading together
// e.g. initial page load is one set of tiles, new sets of tile loads are then initiated by a map pan or zoom
Scene.prototype.trackTileSetLoadStart = function () {
    // Start tracking new tile set if no other tiles already loading
    if (this.tile_set_loading == null) {
        this.tile_set_loading = +new Date();
        log.info('Scene: tile set load start');
    }
};

Scene.prototype.trackTileSetLoadStop = function () {
    // No more tiles actively loading?
    if (this.tile_set_loading != null) {
        var end_tile_set = true;
        for (var t in this.tiles) {
            if (this.tiles[t].loading === true) {
                end_tile_set = false;
                break;
            }
        }

        if (end_tile_set === true) {
            this.last_tile_set_load = (+new Date()) - this.tile_set_loading;
            this.tile_set_loading = null;
            log.info(`Scene: tile set load finished in ${this.last_tile_set_load}ms`);
        }
    }
};

// Sum of a debug property across tiles
Scene.prototype.getDebugSum = function (prop, filter) {
    var sum = 0;
    for (var t in this.tiles) {
        if (this.tiles[t].debug[prop] != null && (typeof filter !== 'function' || filter(this.tiles[t]) === true)) {
            sum += this.tiles[t].debug[prop];
        }
    }
    return sum;
};

// Average of a debug property across tiles
Scene.prototype.getDebugAverage = function (prop, filter) {
    return this.getDebugSum(prop, filter) / Object.keys(this.tiles).length;
};

// Log messages pass through from web workers
Scene.prototype.workerLogMessage = function (event) {
    if (event.data.type !== 'log') {
        return;
    }

    var { worker_id, level, msg } = event.data;

    if (log[level]) {
        log[level](`worker ${worker_id}:`,  ...msg);
    }
    else {
        log.error(`Scene.workerLogMessage: unrecognized log level ${level}`);
    }
};
