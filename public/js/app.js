(function () {
  'use strict';

  function showFatal(msg) {
    const fatal = document.getElementById('fatal');
    const fatalText = document.getElementById('fatalText');
    if (fatalText) fatalText.textContent = msg;
    if (fatal) fatal.style.display = 'flex';
  }

  if (typeof THREE === 'undefined') {
    showFatal('THREE.js не загрузился. Проверь CDN, CSP или интернет.');
    return;
  }

  const SIM = window.SIM = {};

  SIM.CONFIG = {
    gravity: 9.81,
    maxThrust: 29.5,
    maxRate: 3.65,
    yawRate: 2.95,
    response: 8.9,
    dragLinear: 0.16,
    dragQuad: 0.022,
    groundOffset: 0.18,
    crashVerticalSpeed: 4.65,
    crashAngle: 1.18,
    cameraTilt: 0.18,
    gateRadius: 4.35,
    worldBound: 1180,
    altitudeLimit: 820,
    batteryCapacity: 1500,
    mapRange: 720,
    replayMaxFrames: 780,
    replayUseFrames: 520
  };

  SIM.gates = [];

  SIM.runtime = {
    renderer: null,
    scene: null,
    drone: null,
    fpvCamera: null,
    chaseCamera: null,
    activeCamera: null,
    sun: null,
    sunTarget: null,

    propGroups: [],
    propBlurMat: null,
    ledMats: [],

    started: false,
    viewMode: 'fpv',
    helpVisible: false,
    mapVisible: false,

    frame: 0,
    simTime: 0,
    fps: 60,
    fpsTime: performance.now(),
    fpsFrames: 0,
    noiseCtx: null,

    recorder: {
      frames: [],
      max: SIM.CONFIG.replayMaxFrames
    },

    replay: {
      active: false,
      playhead: 0,
      total: 0,
      offset: 0,
      speed: 0.34,
      camTime: 0,
      camForce: -1,
      motor: 0
    }
  };

  SIM.state = {
    armed: false,
    crashed: false,

    throttle: 0,
    motor: 0,

    battery: 100,
    voltage: 16.8,
    current: 0,

    time: 0,
    lapStartTime: 0,
    lap: 1,
    nextGate: 0,
    bestLap: 0,
    lastLap: 0,

    rssi: 100,
    link: 100,
    gps: 12,
    distance: 0,

    pos: new THREE.Vector3(0, 0.2, 0),
    vel: new THREE.Vector3(0, 0, 0),
    quat: new THREE.Quaternion(0, 0, 0, 1),
    angVel: new THREE.Vector3(0, 0, 0),
    wind: new THREE.Vector3(0, 0, 0)
  };

  SIM.utils = {
    clamp(v, a, b) {
      return Math.max(a, Math.min(b, v));
    },

    rand(a, b) {
      return a + Math.random() * (b - a);
    },

    smoothstep(edge0, edge1, x) {
      const t = SIM.utils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
      return t * t * (3 - 2 * t);
    },

    formatTime(sec) {
      if (!isFinite(sec) || sec <= 0) return '--:--.---';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      const ms = Math.floor((sec % 1) * 1000);
      return (
        String(m).padStart(2, '0') + ':' +
        String(s).padStart(2, '0') + '.' +
        String(ms).padStart(3, '0')
      );
    },

    dom(id) {
      return document.getElementById(id);
    }
  };

  SIM.input = {
    keys: Object.create(null),

    init() {
      window.addEventListener('keydown', this.onKeyDown.bind(this), { passive: false });
      window.addEventListener('keyup', this.onKeyUp.bind(this), { passive: false });
      window.addEventListener('blur', this.clear.bind(this));

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.clear();
      });
    },

    clear() {
      Object.keys(this.keys).forEach((k) => {
        this.keys[k] = false;
      });
    },

    onKeyDown(e) {
      const blocked = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (blocked.indexOf(e.code) !== -1) {
        e.preventDefault();
      }

      this.keys[e.code] = true;
      if (e.repeat) return;

      const main = SIM.main;
      const rt = SIM.runtime;
      if (!main || !rt) return;

      if (rt.replay.active) {
        if (e.code === 'Space' || e.code === 'Escape') {
          SIM.replay.stop(true);
        }

        if (e.code === 'KeyR') {
          SIM.replay.stop(false);
          main.reset();
        }

        if (e.code === 'KeyC') {
          rt.replay.camForce = (rt.replay.camForce + 1) % 4;
        }

        return;
      }

      if (e.code === 'Enter' && !rt.started) {
        main.start();
        return;
      }

      if (!rt.started) return;

      if (e.code === 'Space') main.toggleArm();
      if (e.code === 'KeyR') main.reset();
      if (e.code === 'KeyC') main.toggleView();
      if (e.code === 'KeyH') main.toggleHelp();
      if (e.code === 'KeyM') main.toggleMap();
      if (e.code === 'KeyP') main.watchReplay();

      if (e.code === 'Escape') {
        if (rt.mapVisible) main.toggleMap();
        if (rt.helpVisible) main.toggleHelp();
      }
    },

    onKeyUp(e) {
      this.keys[e.code] = false;
    }
  };

  SIM.world = {
    heightAt(x, z) {
      const u = SIM.utils;
      const d = Math.sqrt(x * x + z * z);
      const flat = u.smoothstep(75, 240, d);

      let h =
        Math.sin(x * 0.008) * Math.cos(z * 0.009) * 12 +
        Math.sin(x * 0.023 + z * 0.017) * 3.2 +
        Math.cos(x * 0.004 - z * 0.011) * 7.5;

      h *= flat;

      const lakeX = 310;
      const lakeZ = 260;
      const lake = -10 * Math.exp(-(((x - lakeX) * (x - lakeX) + (z - lakeZ) * (z - lakeZ)) / 12000));

      const mountainX = -430;
      const mountainZ = 380;
      const mountain = 24 * Math.exp(-(((x - mountainX) * (x - mountainX) + (z - mountainZ) * (z - mountainZ)) / 52000));

      return h + lake + mountain;
    },

    create(scene) {
      const rt = SIM.runtime;
      rt.scene = scene;

      scene.background = new THREE.Color(0x8fd2ff);
      scene.fog = new THREE.Fog(0x9ed8ff, 90, 1020);

      this.addLights(scene);
      this.addTerrain(scene);
      this.addWater(scene);
      this.addRunway(scene);
      this.addTrees(scene);
      this.addBuildings(scene);
      this.addClouds(scene);
      this.addGates(scene);
      this.addRunwayLights(scene);
      this.addWindsock(scene);
    },

    addLights(scene) {
      const rt = SIM.runtime;

      const hemi = new THREE.HemisphereLight(0xcfefff, 0x223322, 0.92);
      scene.add(hemi);

      const sun = new THREE.DirectionalLight(0xfff2cc, 1.18);
      sun.position.set(130, 190, 90);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -240;
      sun.shadow.camera.right = 240;
      sun.shadow.camera.top = 240;
      sun.shadow.camera.bottom = -240;
      sun.shadow.camera.near = 10;
      sun.shadow.camera.far = 800;
      sun.shadow.bias = -0.0004;

      const sunTarget = new THREE.Object3D();
      scene.add(sunTarget);
      sun.target = sunTarget;

      scene.add(sun);

      rt.sun = sun;
      rt.sunTarget = sunTarget;

      const sunBall = new THREE.Mesh(
        new THREE.SphereGeometry(16, 18, 18),
        new THREE.MeshBasicMaterial({ color: 0xfff3b8 })
      );
      sunBall.position.set(430, 290, 270);
      scene.add(sunBall);
    },

    addTerrain(scene) {
      const size = 2500;
      const segments = 170;

      const geo = new THREE.PlaneGeometry(size, size, segments, segments);
      geo.rotateX(-Math.PI / 2);

      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);

      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const h = this.heightAt(x, z);
        pos.setY(i, h);

        let r, g, b;
        const v = 0.9 + Math.random() * 0.2;

        if (h < -1.3) {
          r =
