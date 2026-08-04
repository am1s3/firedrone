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
          r = 0.06; g = 0.16; b = 0.22;
        } else if (h < 0.35) {
          r = 0.48; g = 0.44; b = 0.26;
        } else if (h < 6) {
          r = 0.16; g = 0.36; b = 0.14;
        } else if (h < 14) {
          r = 0.24; g = 0.30; b = 0.14;
        } else if (h < 24) {
          r = 0.35; g = 0.30; b = 0.24;
        } else {
          r = 0.75; g = 0.76; b = 0.78;
        }

        colors[i * 3 + 0] = r * v;
        colors[i * 3 + 1] = g * v;
        colors[i * 3 + 2] = b * v;
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        metalness: 0
      });

      const terrain = new THREE.Mesh(geo, mat);
      terrain.receiveShadow = true;
      scene.add(terrain);
    },

    addWater(scene) {
      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(2500, 2500),
        new THREE.MeshStandardMaterial({
          color: 0x1663a8,
          transparent: true,
          opacity: 0.82,
          roughness: 0.14,
          metalness: 0.35
        })
      );

      water.rotation.x = -Math.PI / 2;
      water.position.y = -1.35;
      scene.add(water);
    },

    addRunway(scene) {
      const asphaltCanvas = document.createElement('canvas');
      asphaltCanvas.width = 256;
      asphaltCanvas.height = 256;
      const g = asphaltCanvas.getContext('2d');

      g.fillStyle = '#25282c';
      g.fillRect(0, 0, 256, 256);

      for (let i = 0; i < 3600; i++) {
        const v = 18 + Math.random() * 48;
        g.fillStyle = `rgba(${v},${v + 2},${v + 5},${0.08 + Math.random() * 0.22})`;
        g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }

      const asphaltTex = new THREE.CanvasTexture(asphaltCanvas);
      asphaltTex.wrapS = THREE.RepeatWrapping;
      asphaltTex.wrapT = THREE.RepeatWrapping;
      asphaltTex.repeat.set(2, 18);

      const runway = new THREE.Mesh(
        new THREE.PlaneGeometry(26, 300),
        new THREE.MeshStandardMaterial({
          map: asphaltTex,
          roughness: 0.96,
          metalness: 0.02
        })
      );
      runway.rotation.x = -Math.PI / 2;
      runway.position.set(0, 0.02, -30);
      runway.receiveShadow = true;
      scene.add(runway);

      const centerLine = new THREE.Mesh(
        new THREE.PlaneGeometry(0.55, 300),
        new THREE.MeshBasicMaterial({
          color: 0xd8e6e2,
          transparent: true,
          opacity: 0.65
        })
      );
      centerLine.rotation.x = -Math.PI / 2;
      centerLine.position.set(0, 0.03, -30);
      scene.add(centerLine);

      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(5.4, 48),
        new THREE.MeshStandardMaterial({
          color: 0x101317,
          roughness: 0.7,
          metalness: 0.18
        })
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(0, 0.03, 0);
      pad.receiveShadow = true;
      scene.add(pad);

      const padRing = new THREE.Mesh(
        new THREE.RingGeometry(4.7, 5.4, 64),
        new THREE.MeshBasicMaterial({
          color: 0x00ffd0,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide
        })
      );
      padRing.rotation.x = -Math.PI / 2;
      padRing.position.set(0, 0.04, 0);
      scene.add(padRing);
    },

    addTrees(scene) {
      const count = 340;
      const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.25, 7);
      const leafGeo = new THREE.ConeGeometry(1.25, 3.2, 8);

      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
      const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f7d32, roughness: 0.9 });

      const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
      const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, count);

      trunkMesh.castShadow = true;
      leafMesh.castShadow = true;

      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const e = new THREE.Euler();

      let placed = 0;
      let attempts = 0;

      while (placed < count && attempts < count * 10) {
        attempts++;

        const x = SIM.utils.rand(-980, 980);
        const z = SIM.utils.rand(-980, 980);

        if (Math.abs(x) < 28 && z > -195 && z < 145) continue;

        const h = this.heightAt(x, z);
        if (h < 0.15 || h > 24) continue;

        const scale = SIM.utils.rand(0.75, 2.4);
        const rot = SIM.utils.rand(0, Math.PI * 2);

        q.setFromEuler(e.set(0, rot, 0));

        p.set(x, h + 0.62 * scale, z);
        s.setScalar(scale);
        m.compose(p, q, s);
        trunkMesh.setMatrixAt(placed, m);

        p.set(x, h + 2.35 * scale, z);
        m.compose(p, q, s);
        leafMesh.setMatrixAt(placed, m);

        placed++;
      }

      trunkMesh.count = placed;
      leafMesh.count = placed;
      trunkMesh.instanceMatrix.needsUpdate = true;
      leafMesh.instanceMatrix.needsUpdate = true;

      scene.add(trunkMesh);
      scene.add(leafMesh);
    },

    addBuildings(scene) {
      const baseCanvas = document.createElement('canvas');
      baseCanvas.width = 256;
      baseCanvas.height = 512;
      const g = baseCanvas.getContext('2d');

      g.fillStyle = '#151a21';
      g.fillRect(0, 0, 256, 512);

      for (let y = 18; y < 490; y += 28) {
        for (let x = 14; x < 234; x += 30) {
          const lit = Math.random() < 0.34;
          g.fillStyle = lit
            ? `rgba(${150 + Math.random() * 105},${210 + Math.random() * 45},${120 + Math.random() * 135},${0.65 + Math.random() * 0.35})`
            : 'rgba(25,35,48,0.95)';
          g.fillRect(x, y, 18, 16);
        }
      }

      g.fillStyle = 'rgba(255,255,255,0.05)';
      for (let x = 0; x < 256; x += 30) {
        g.fillRect(x, 0, 2, 512);
      }

      const baseTex = new THREE.CanvasTexture(baseCanvas);
      const roofMat = new THREE.MeshStandardMaterial({
        color: 0x0c0f14,
        roughness: 0.82,
        metalness: 0.12
      });

      for (let i = 0; i < 18; i++) {
        const a = SIM.utils.rand(0, Math.PI * 2);
        const d = SIM.utils.rand(170, 520);
        const x = Math.cos(a) * d;
        const z = Math.sin(a) * d;

        if (Math.abs(x) < 60 && z > -210 && z < 180) continue;

        const hGround = this.heightAt(x, z);
        if (hGround < 0.3 || hGround > 18) continue;

        const w = SIM.utils.rand(14, 32);
        const h = SIM.utils.rand(22, 82);
        const depth = SIM.utils.rand(14, 30);

        const tex = baseTex.clone();
        tex.needsUpdate = true;
        tex.repeat.set(Math.max(1, w / 18), Math.max(1, h / 28));

        const wallMat = new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.72,
          metalness: 0.18
        });

        const b = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, depth),
          [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat]
        );

        b.position.set(x, hGround + h / 2 - 0.5, z);
        b.castShadow = true;
        b.receiveShadow = true;
        scene.add(b);
      }
    },

    addClouds(scene) {
      const cloudMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.46,
        roughness: 1,
        metalness: 0
      });

      for (let i = 0; i < 15; i++) {
        const cloud = new THREE.Group();
        const puffs = 3 + Math.floor(Math.random() * 4);

        for (let j = 0; j < puffs; j++) {
          const s = SIM.utils.rand(10, 32);
          const puff = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 10), cloudMat);
          puff.position.set(
            SIM.utils.rand(-28, 28),
            SIM.utils.rand(-6, 10),
            SIM.utils.rand(-18, 18)
          );
          cloud.add(puff);
        }

        cloud.position.set(
          SIM.utils.rand(-900, 900),
          SIM.utils.rand(150, 260),
          SIM.utils.rand(-900, 900)
        );

        scene.add(cloud);
      }
    },

    addGates(scene) {
      const cfg = SIM.CONFIG;
      SIM.gates = [];

      const specs = [
        [0, -45, 4, 0],
        [35, -95, 7, -0.5],
        [85, -140, 12, -1.05],
        [160, -120, 16, -1.7],
        [195, -35, 9, -2.35],
        [165, 70, 13, -2.9],
        [80, 125, 18, 0.35],
        [-20, 150, 10, 0.9],
        [-120, 120, 7, 1.45],
        [-180, 20, 12, 1.9],
        [-140, -90, 16, 2.45],
        [-60, -65, 6, 2.9]
      ];

      specs.forEach((spec) => {
        this.createGate(scene, spec[0], spec[1], spec[2], spec[3]);
      });
    },

    createGate(scene, x, z, aboveGround, ry) {
      const cfg = SIM.CONFIG;
      const groundH = this.heightAt(x, z);
      const y = groundH + aboveGround;

      const group = new THREE.Group();

      const mat = new THREE.MeshStandardMaterial({
        color: 0x0b0e13,
        emissive: 0x00ffd0,
        emissiveIntensity: 0.5,
        roughness: 0.26,
        metalness: 0.72
      });

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(cfg.gateRadius, 0.35, 12, 48),
        mat
      );
      ring.castShadow = true;
      group.add(ring);

      const halo = new THREE.Mesh(
        new THREE.RingGeometry(cfg.gateRadius - 0.65, cfg.gateRadius + 0.72, 48),
        new THREE.MeshBasicMaterial({
          color: 0x00ffd0,
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide
        })
      );
      group.add(halo);

      const pylonMat = new THREE.MeshStandardMaterial({
        color: 0x232830,
        roughness: 0.72,
        metalness: 0.2
      });

      const supportH = Math.max(1, aboveGround);
      const pylonGeo = new THREE.CylinderGeometry(0.2, 0.3, supportH, 10);

      const p1 = new THREE.Mesh(pylonGeo, pylonMat);
      p1.position.set(-cfg.gateRadius * 0.92, -supportH / 2, 0);
      p1.castShadow = true;

      const p2 = p1.clone();
      p2.position.x = cfg.gateRadius * 0.92;

      group.add(p1, p2);

      group.position.set(x, y, z);
      group.rotation.y = ry;
      scene.add(group);

      SIM.gates.push({
        group,
        ring,
        mat,
        halo,
        pos: group.position,
        x,
        z
      });
    },

    addRunwayLights(scene) {
      const lightMat = new THREE.MeshBasicMaterial({ color: 0x00ffd0 });
      const sphereGeo = new THREE.SphereGeometry(0.22, 8, 8);

      for (let z = -170; z <= 120; z += 20) {
        const left = new THREE.Mesh(sphereGeo, lightMat);
        left.position.set(-13.7, 0.16, z);
        scene.add(left);

        const right = new THREE.Mesh(sphereGeo, lightMat);
        right.position.set(13.7, 0.16, z);
        scene.add(right);
      }
    },

    addWindsock(scene) {
      const poleMat = new THREE.MeshStandardMaterial({
        color: 0x8f98a3,
        roughness: 0.35,
        metalness: 0.8
      });

      const sockMat = new THREE.MeshStandardMaterial({
        color: 0xff7a1a,
        roughness: 0.55,
        metalness: 0.1,
        side: THREE.DoubleSide
      });

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5.5, 10), poleMat);
      pole.position.set(19, 2.75, 12);
      pole.castShadow = true;
      scene.add(pole);

      const sock = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.2, 10, 1, true), sockMat);
      sock.rotation.z = Math.PI / 2;
      sock.position.set(20.2, 5.15, 12);
      sock.castShadow = true;
      scene.add(sock);
    }
  };

  SIM.drone = (function () {
    const _v1 = new THREE.Vector3();
    const _e1 = new THREE.Euler();
    const _e2 = new THREE.Euler();

    function makeCarbonTexture() {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      const g = c.getContext('2d');

      g.fillStyle = '#101318';
      g.fillRect(0, 0, 128, 128);

      for (let y = 0; y < 128; y += 8) {
        for (let x = 0; x < 128; x += 8) {
          g.fillStyle = ((x + y) / 8) % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.2)';
          g.fillRect(x, y, 8, 8);
        }
      }

      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(2, 2);
      return tex;
    }

    function makePropeller(blurMat) {
      const group = new THREE.Group();

      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.022, 0.018, 10),
        new THREE.MeshStandardMaterial({ color: 0xdfe5ea, roughness: 0.2, metalness: 0.9 })
      );
      group.add(hub);

      const bladeGeo = new THREE.BoxGeometry(0.17, 0.004, 0.022);
      const bladeMat = new THREE.MeshStandardMaterial({
        color: 0xd8d8d8,
        transparent: true,
        opacity: 0.92,
        roughness: 0.18,
        metalness: 0.84
      });

      const blade1 = new THREE.Mesh(bladeGeo, bladeMat);
      blade1.position.x = 0.085;
      blade1.rotation.x = 0.42;
      group.add(blade1);

      const blade2 = new THREE.Mesh(bladeGeo, bladeMat);
      blade2.position.x = -0.085;
      blade2.rotation.x = -0.42;
      group.add(blade2);

      const blur = new THREE.Mesh(
        new THREE.CircleGeometry(0.19, 18),
        blurMat
      );
      blur.rotation.x = -Math.PI / 2;
      blur.position.y = 0.004;
      group.add(blur);

      return group;
    }

    return {
      build(scene) {
        const rt = SIM.runtime;
        const cfg = SIM.CONFIG;

        const drone = new THREE.Group();

        const carbonTex = makeCarbonTexture();
        const carbonMat = new THREE.MeshStandardMaterial({
          map: carbonTex,
          color: 0x2a2f36,
          roughness: 0.38,
          metalness: 0.62
        });

        const bodyMat = new THREE.MeshStandardMaterial({
          color: 0x111318,
          roughness: 0.34,
          metalness: 0.68
        });

        const accentMat = new THREE.MeshStandardMaterial({
          color: 0xff2d55,
          roughness: 0.3,
          metalness: 0.42,
          emissive: 0x3f0012
        });

        const glassMat = new THREE.MeshStandardMaterial({
          color: 0x05070a,
          roughness: 0.08,
          metalness: 0.9
        });

        const motorMat = new THREE.MeshStandardMaterial({
          color: 0xb9c2cc,
          roughness: 0.2,
          metalness: 0.92
        });

        const pcbMat = new THREE.MeshStandardMaterial({
          color: 0x0d5e2d,
          roughness: 0.4,
          metalness: 0.2
        });

        const electronicsMat = new THREE.MeshStandardMaterial({
          color: 0x0a0d12,
          roughness: 0.5,
          metalness: 0.4
        });

        const bottomPlate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.5), carbonMat);
        bottomPlate.castShadow = true;
        drone.add(bottomPlate);

        const topPlate = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.4), carbonMat);
        topPlate.position.y = 0.095;
        topPlate.castShadow = true;
        drone.add(topPlate);

        const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.42), bodyMat);
        body.position.y = 0.045;
        body.castShadow = true;
        drone.add(body);

        const standoffGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.08, 8);
        const standoffMat = new THREE.MeshStandardMaterial({
          color: 0xaeb6bf,
          roughness: 0.25,
          metalness: 0.9
        });

        const standoffPositions = [
          [0.14, 0.14],
          [-0.14, 0.14],
          [0.14, -0.14],
          [-0.14, -0.14]
        ];

        standoffPositions.forEach((p) => {
          const standoff = new THREE.Mesh(standoffGeo, standoffMat);
          standoff.position.set(p[0], 0.06, p[1]);
          standoff.castShadow = true;
          drone.add(standoff);
        });

        const fc = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, 0.16), pcbMat);
        fc.position.y = 0.082;
        drone.add(fc);

        const esc = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.016, 0.14), electronicsMat);
        esc.position.y = 0.068;
        drone.add(esc);

        const capacitor = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), electronicsMat);
        capacitor.position.set(0.08, 0.09, 0.08);
        capacitor.castShadow = true;
        drone.add(capacitor);

        const rx = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.015, 0.08), new THREE.MeshStandardMaterial({
          color: 0x10457e,
          roughness: 0.4,
          metalness: 0.2
        }));
        rx.position.set(-0.08, 0.09, 0.08);
        drone.add(rx);

        const battery = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.065, 0.34), accentMat);
        battery.position.set(0, 0.135, 0.04);
        battery.castShadow = true;
        drone.add(battery);

        const strapGeo = new THREE.BoxGeometry(0.03, 0.004, 0.42);
        const strapMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });

        const strap1 = new THREE.Mesh(strapGeo, strapMat);
        strap1.position.set(0, 0.168, 0.04);
        drone.add(strap1);

        const strap2 = strap1.clone();
        strap2.rotation.y = Math.PI / 2;
        strap2.scale.x = 0.8;
        drone.add(strap2);

        const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.22), bodyMat);
        canopy.position.set(0, 0.12, -0.07);
        canopy.castShadow = true;
        drone.add(canopy);

        const gimbalRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.045, 0.008, 8, 18),
          motorMat
        );
        gimbalRing.position.set(0, 0.085, -0.21);
        drone.add(gimbalRing);

        const lens = new THREE.Mesh(
          new THREE.CylinderGeometry(0.028, 0.032, 0.05, 12),
          electronicsMat
        );
        lens.rotation.x = Math.PI / 2;
        lens.position.set(0, 0.085, -0.235);
        drone.add(lens);

        const lensGlass = new THREE.Mesh(
          new THREE.CircleGeometry(0.022, 14),
          new THREE.MeshBasicMaterial({ color: 0x66ccff })
        );
        lensGlass.rotation.y = Math.PI;
        lensGlass.position.set(0, 0.085, -0.261);
        drone.add(lensGlass);

        const antennaGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.12, 6);
        const antennaMat = new THREE.MeshStandardMaterial({ color: 0x20242a, roughness: 0.5 });

        const antenna1 = new THREE.Mesh(antennaGeo, antennaMat);
        antenna1.position.set(0.04, 0.16, 0.15);
        antenna1.rotation.x = -0.7;
        drone.add(antenna1);

        const antenna2 = antenna1.clone();
        antenna2.position.x = -0.04;
        drone.add(antenna2);

        const armGeo = new THREE.BoxGeometry(0.64, 0.026, 0.056);
        const motorBaseGeo = new THREE.CylinderGeometry(0.042, 0.05, 0.03, 12);
        const motorBellGeo = new THREE.CylinderGeometry(0.034, 0.04, 0.035, 12);
        const shaftGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.03, 8);

        rt.propGroups = [];
        rt.propBlurMat = new THREE.MeshBasicMaterial({
          color: 0xaadfff,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide
        });

        const motorPositions = [
          [0.21, -0.21],
          [-0.21, -0.21],
          [0.21, 0.21],
          [-0.21, 0.21]
        ];

        const propDirs = [1, -1, -1, 1];

        motorPositions.forEach(function (p, i) {
          const x = p[0];
          const z = p[1];

          const arm = new THREE.Mesh(armGeo, carbonMat);
          arm.position.set(x / 2, 0.002, z / 2);
          arm.rotation.y = Math.atan2(x, z);
          arm.castShadow = true;
          drone.add(arm);

          const motorBase = new THREE.Mesh(motorBaseGeo, motorMat);
          motorBase.position.set(x, 0.03, z);
          motorBase.castShadow = true;
          drone.add(motorBase);

          const motorBell = new THREE.Mesh(motorBellGeo, motorMat);
          motorBell.position.set(x, 0.055, z);
          motorBell.castShadow = true;
          drone.add(motorBell);

          const shaft = new THREE.Mesh(shaftGeo, standoffMat);
          shaft.position.set(x, 0.078, z);
          drone.add(shaft);

          const prop = makePropeller(rt.propBlurMat);
          prop.position.set(x, 0.088, z);
          drone.add(prop);

          rt.propGroups.push(prop);
        });

        rt.propDirs = propDirs;

        const frontLedMat = new THREE.MeshStandardMaterial({
          color: 0x003311,
          emissive: 0x00ff66,
          emissiveIntensity: 0.2
        });

        const rearLedMat = new THREE.MeshStandardMaterial({
          color: 0x330000,
          emissive: 0xff2222,
          emissiveIntensity: 0.2
        });

        const ledGeo = new THREE.SphereGeometry(0.018, 8, 8);

        const frontLed = new THREE.Mesh(ledGeo, frontLedMat);
        frontLed.position.set(0, 0.045, -0.25);
        drone.add(frontLed);

        const rearLed = new THREE.Mesh(ledGeo, rearLedMat);
        rearLed.position.set(0, 0.045, 0.25);
        drone.add(rearLed);

        rt.ledMats = [frontLedMat, rearLedMat];

        const fpvCamera = new THREE.PerspectiveCamera(
          112,
          window.innerWidth / window.innerHeight,
          0.05,
          2200
        );
        fpvCamera.position.set(0, 0.088, -0.24);
        fpvCamera.rotation.x = cfg.cameraTilt;
        drone.add(fpvCamera);

        const chaseCamera = new THREE.PerspectiveCamera(
          70,
          window.innerWidth / window.innerHeight,
          0.1,
          2500
        );
        chaseCamera.position.set(0, 4, 10);

        rt.drone = drone;
        rt.fpvCamera = fpvCamera;
        rt.chaseCamera = chaseCamera;
        rt.activeCamera = fpvCamera;

        scene.add(drone);
      },

      updateVisuals(dt, t) {
        const rt = SIM.runtime;
        const st = SIM.state;
        const cfg = SIM.CONFIG;

        rt.drone.position.copy(st.pos);
        rt.drone.quaternion.copy(st.quat);

        const spin = st.armed
          ? 30 + st.motor * 285
          : Math.max(0, st.motor * 25);

        for (let i = 0; i < rt.propGroups.length; i++) {
          rt.propGroups[i].rotation.y += spin * dt * (rt.propDirs ? rt.propDirs[i] : 1);
        }

        if (rt.propBlurMat) {
          rt.propBlurMat.opacity = SIM.utils.clamp(st.motor * 0.45, 0, 0.5);
        }

        if (rt.ledMats.length >= 2) {
          rt.ledMats[0].emissiveIntensity = st.armed
            ? (Math.sin(t * 18) > 0 ? 1.6 : 0.18)
            : 0.08;

          rt.ledMats[1].emissiveIntensity = st.armed
            ? (Math.sin(t * 18 + Math.PI) > 0 ? 1.6 : 0.18)
            : 0.08;
        }

        const speed = st.vel.length();
        const shakeBase =
          (st.armed ? 0.002 + st.motor * 0.0048 : 0.0005) +
          st.angVel.length() * 0.0016 +
          (st.crashed ? 0.028 : 0);

        rt.fpvCamera.position.set(
          (Math.random() - 0.5) * shakeBase,
          0.088 + (Math.random() - 0.5) * shakeBase,
          -0.24 + (Math.random() - 0.5) * shakeBase
        );

        rt.fpvCamera.rotation.x = cfg.cameraTilt + (Math.random() - 0.5) * shakeBase * 1.7;
        rt.fpvCamera.rotation.z = (Math.random() - 0.5) * shakeBase * 1.9;

        const targetFov = SIM.utils.clamp(108 + speed * 0.25 + st.motor * 10, 108, 132);
        if (Math.abs(rt.fpvCamera.fov - targetFov) > 0.05) {
          rt.fpvCamera.fov = targetFov;
          rt.fpvCamera.updateProjectionMatrix();
        }
      },

      updateCamera(dt) {
        const rt = SIM.runtime;
        const st = SIM.state;

        if (rt.viewMode === 'fpv') {
          rt.activeCamera = rt.fpvCamera;
          return;
        }

        rt.activeCamera = rt.chaseCamera;

        _e1.setFromQuaternion(st.quat, 'YXZ');
        _e2.set(0, _e1.y, 0, 'YXZ');

        _v1.set(0, 2.6, 6.6).applyEuler(_e2).add(st.pos);

        const k = 1 - Math.exp(-dt * 4.8);
        rt.chaseCamera.position.lerp(_v1, k);

        const groundH = SIM.world.heightAt(rt.chaseCamera.position.x, rt.chaseCamera.position.z) + 0.85;
        if (rt.chaseCamera.position.y < groundH) {
          rt.chaseCamera.position.y = groundH;
        }

        rt.chaseCamera.lookAt(st.pos.x, st.pos.y + 0.35, st.pos.z);
      }
    };
  })();

  SIM.minimap = {
    terrainCanvas: null,
    _euler: null,

    init() {
      this._euler = new THREE.Euler();
      this.terrainCanvas = this.makeTerrainCanvas(SIM.CONFIG.mapRange, 256);
    },

    makeTerrainCanvas(range, size) {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;

      const ctx = c.getContext('2d');
      const img = ctx.createImageData(size, size);
      const data = img.data;

      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const wx = (x / size * 2 - 1) * range;
          const wz = (y / size * 2 - 1) * range;
          const h = SIM.world.heightAt(wx, wz);

          let r, g, b;

          if (h < -1.3) {
            r = 16; g = 48; b = 66;
          } else if (h < 0.35) {
            r = 122; g = 112; b = 66;
          } else if (h < 6) {
            r = 36; g = 86; b = 34;
          } else if (h < 14) {
            r = 58; g = 74; b = 34;
          } else if (h < 24) {
            r = 88; g = 74; b = 58;
          } else {
            r = 186; g = 190; b = 196;
          }

          const idx = (y * size + x) * 4;
          data[idx + 0] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 255;
        }
      }

      ctx.putImageData(img, 0, 0);
      return c;
    },

    drawMini() {
      const canvas = SIM.utils.dom('minimapCanvas');
      this.draw(canvas, false);
    },

    drawFull() {
      const canvas = SIM.utils.dom('fullMapCanvas');
      this.draw(canvas, true);
    },

    draw(canvas, detailed) {
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      const size = canvas.width;
      const range = SIM.CONFIG.mapRange;
      const st = SIM.state;
      const rt = SIM.runtime;

      ctx.clearRect(0, 0, size, size);

      if (this.terrainCanvas) {
        ctx.drawImage(this.terrainCanvas, 0, 0, size, size);
      } else {
        ctx.fillStyle = '#08120c';
        ctx.fillRect(0, 0, size, size);
      }

      const scale = size / (range * 2);
      const toPx = (x) => (x + range) * scale;

      if (detailed) {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;

        for (let i = 0; i <= 12; i++) {
          const p = i * size / 12;
          ctx.beginPath();
          ctx.moveTo(p, 0);
          ctx.lineTo(p, size);
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(0, p);
          ctx.lineTo(size, p);
          ctx.stroke();
        }
      }

      ctx.fillStyle = 'rgba(18,20,24,0.9)';
      ctx.fillRect(toPx(-13), toPx(-180), 26 * scale, 300 * scale);

      ctx.strokeStyle = 'rgba(0,255,210,0.8)';
      ctx.lineWidth = detailed ? 2 : 1;
      ctx.beginPath();
      ctx.arc(toPx(0), toPx(0), 5.4 * scale, 0, Math.PI * 2);
      ctx.stroke();

      for (let i = 0; i < SIM.gates.length; i++) {
        const g = SIM.gates[i];
        const x = toPx(g.x);
        const y = toPx(g.z);

        const isNext = i === st.nextGate;
        const passed = i < st.nextGate;
        const pulse = isNext ? 1 + Math.sin(rt.simTime * 6) * 0.25 : 1;

        ctx.beginPath();
        ctx.arc(x, y, (detailed ? 7 : 5) * pulse, 0, Math.PI * 2);

        if (isNext) {
          ctx.fillStyle = 'rgba(0,255,210,0.95)';
          ctx.strokeStyle = 'rgba(0,255,210,0.95)';
        } else if (passed) {
          ctx.fillStyle = 'rgba(255,80,80,0.8)';
          ctx.strokeStyle = 'rgba(255,80,80,0.8)';
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        }

        ctx.fill();

        if (detailed) {
          ctx.fillStyle = 'rgba(255,255,255,0.88)';
          ctx.font = '12px Consolas, monospace';
          ctx.fillText(String(i + 1), x + 8, y - 8);
        }
      }

      this._euler.setFromQuaternion(st.quat, 'YXZ');

      ctx.save();
      ctx.translate(toPx(st.pos.x), toPx(st.pos.z));
      ctx.rotate(-this._euler.y);

      ctx.beginPath();
      ctx.moveTo(0, detailed ? -9 : -7);
      ctx.lineTo(detailed ? 6 : 5, detailed ? 7 : 6);
      ctx.lineTo(detailed ? -6 : -5, detailed ? 7 : 6);
      ctx.closePath();

      ctx.fillStyle = st.armed ? 'rgba(84,255,157,0.98)' : 'rgba(255,93,93,0.95)';
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 12;
      ctx.fill();

      ctx.restore();

      if (detailed) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '14px Consolas, monospace';
        ctx.fillText('N', size - 18, 18);
        ctx.fillText('SCALE ~ ' + range + 'm', 12, size - 12);
        ctx.fillText('GATE ' + (st.nextGate + 1) + '/' + SIM.gates.length, 12, 20);
        ctx.fillText('LAP ' + st.lap, 12, 38);
      }
    }
  };

  SIM.hud = {
    els: {},
    _euler: null,

    init() {
      this._euler = new THREE.Euler();

      const ids = [
        'armed', 'mode', 'timer', 'gate', 'lap', 'best', 'heading', 'fps',
        'alt', 'spd', 'vs', 'thr',
        'thrFill', 'batteryFill', 'voltage', 'rssi', 'gps',
        'horizonInner'
      ];

      ids.forEach((id) => {
        this.els[id] = SIM.utils.dom(id);
      });
    },

    update() {
      const st = SIM.state;
      const rt = SIM.runtime;
      const u = SIM.utils;
      const els = this.els;

      this._euler.setFromQuaternion(st.quat, 'YXZ');

      const pitchDeg = THREE.MathUtils.radToDeg(this._euler.x);
      const rollDeg = THREE.MathUtils.radToDeg(this._euler.z);
      const yawDeg = (THREE.MathUtils.radToDeg(this._euler.y) + 360) % 360;
      const heading = Math.round((360 - yawDeg) % 360);

      if (els.heading) els.heading.textContent = String(heading).padStart(3, '0') + '°';
      if (els.fps) els.fps.textContent = Math.round(rt.fps) + ' FPS';

      if (els.horizonInner) {
        els.horizonInner.style.transform =
          'translate(-50%, -50%) rotate(' + rollDeg.toFixed(2) + 'deg) translateY(' +
          (pitchDeg * 2.8).toFixed(2) + 'px)';
      }

      const groundH = SIM.world.heightAt(st.pos.x, st.pos.z);
      const agl = Math.max(0, st.pos.y - groundH);
      const speed = st.vel.length() * 3.6;

      if (els.alt) els.alt.textContent = agl.toFixed(1) + ' m';
      if (els.spd) els.spd.textContent = Math.round(speed) + ' km/h';
      if (els.vs) els.vs.textContent = st.vel.y.toFixed(1) + ' m/s';
      if (els.thr) els.thr.textContent = Math.round(st.throttle * 100) + '%';

      if (els.thrFill) els.thrFill.style.width = (st.throttle * 100).toFixed(0) + '%';
      if (els.batteryFill) {
        els.batteryFill.style.width = st.battery.toFixed(0) + '%';
        els.batteryFill.className = st.battery > 40 ? '' : (st.battery > 18 ? 'warn' : 'bad');
      }

      if (els.voltage) els.voltage.textContent = st.voltage.toFixed(1) + 'V';
      if (els.rssi) els.rssi.textContent = 'RSSI ' + Math.round(st.rssi) + '%';
      if (els.gps) els.gps.textContent = 'GPS ' + Math.round(st.gps) + ' SAT';

      if (els.timer) els.timer.textContent = u.formatTime(st.time);
      if (els.best) els.best.textContent = 'BEST ' + u.formatTime(st.bestLap);
      if (els.gate) els.gate.textContent = 'GATE ' + (st.nextGate + 1) + '/' + (SIM.gates.length || 1);
      if (els.lap) els.lap.textContent = 'LAP ' + st.lap;

      if (els.armed) {
        els.armed.textContent = st.armed ? 'ARMED' : 'DISARMED';
        els.armed.className = 'chip ' + (st.armed ? 'armed' : 'disarmed');
      }

      if (els.mode) {
        els.mode.textContent = rt.viewMode === 'fpv' ? 'FPV' : 'CHASE';
      }
    }
  };

  SIM.replay = (function () {
    const _v1 = new THREE.Vector3();
    const _v2 = new THREE.Vector3();
    const _q1 = new THREE.Quaternion();
    const _q2 = new THREE.Quaternion();
    const _e1 = new THREE.Euler();
    const _e2 = new THREE.Euler();

    return {
      record() {
        const rt = SIM.runtime;
        const st = SIM.state;
        const rec = rt.recorder;

        if (rt.replay.active) return;

        rec.frames.push({
          t: rt.simTime,
          x: st.pos.x,
          y: st.pos.y,
          z: st.pos.z,
          qx: st.quat.x,
          qy: st.quat.y,
          qz: st.quat.z,
          qw: st.quat.w,
          m: st.motor
        });

        if (rec.frames.length > rec.max) {
          rec.frames.shift();
        }
      },

      getFrame(i) {
        const frames = SIM.runtime.recorder.frames;
        return frames[i] || null;
      },

      start(auto) {
        const rt = SIM.runtime;
        const rp = rt.replay;
        const rec = rt.recorder;

        if (rp.active) return false;
        if (rec.frames.length < 25) return false;

        rp.active = true;
        rp.total = Math.min(rec.frames.length, SIM.CONFIG.replayUseFrames);
        rp.offset = rec.frames.length - rp.total;
        rp.playhead = 0;
        rp.speed = auto ? 0.32 : 0.45;
        rp.camTime = 0;
        rp.camForce = -1;
        rp.motor = 0;

        document.body.classList.add('cinematic');
        SIM.utils.dom('crashOverlay').style.display = 'none';
        SIM.utils.dom('replayBadge').textContent = auto
          ? 'CRASH REPLAY // CINEMATIC'
          : 'REPLAY // CINEMATIC';

        if (SIM.audio && SIM.audio.uiBeep) SIM.audio.uiBeep();
        return true;
      },

      stop(showCrashIfCrashed) {
        const rt = SIM.runtime;
        const rp = rt.replay;
        const st = SIM.state;

        if (!rp.active) return;

        rp.active = false;
        document.body.classList.remove('cinematic');

        if (rt.drone) {
          rt.drone.position.copy(st.pos);
          rt.drone.quaternion.copy(st.quat);
        }

        if (st.crashed && showCrashIfCrashed !== false && SIM.main) {
          SIM.main.showCrash();
        }
      },

      applyFrame(playhead) {
        const rt = SIM.runtime;
        const rp = rt.replay;

        const i = Math.floor(playhead);
        const frac = playhead - i;

        const a = this.getFrame(rp.offset + i);
        const b = this.getFrame(rp.offset + Math.min(i + 1, rp.total - 1));

        if (!a || !b) return;

        _v1.set(a.x, a.y, a.z);
        _v2.set(b.x, b.y, b.z);
        rt.drone.position.lerpVectors(_v1, _v2, frac);

        _q1.set(a.qx, a.qy, a.qz, a.qw);
        _q2.set(b.qx, b.qy, b.qz, b.qw);
        rt.drone.quaternion.copy(_q1).slerp(_q2, frac);

        rp.motor = a.m + (b.m - a.m) * frac;

        if (rt.propBlurMat) {
          rt.propBlurMat.opacity = SIM.utils.clamp(rp.motor * 0.45, 0, 0.5);
        }
      },

      updateProps(dt) {
        const rt = SIM.runtime;
        const rp = rt.replay;

        const spin = 30 + rp.motor * 285;
        for (let i = 0; i < rt.propGroups.length; i++) {
          rt.propGroups[i].rotation.y += spin * dt * (rt.propDirs ? rt.propDirs[i] : 1);
        }
      },

      updateCamera(dt) {
        const rt = SIM.runtime;
        const rp = rt.replay;
        const drone = rt.drone;
        const pos = drone.position;

        _e1.setFromQuaternion(drone.quaternion, 'YXZ');

        const mode = rp.camForce >= 0
          ? rp.camForce
          : Math.floor(rp.camTime / 3.2) % 4;

        if (mode === 0) {
          const a = rp.camTime * 0.72;
          _v1.set(
            pos.x + Math.cos(a) * 7.2,
            pos.y + 2.5,
            pos.z + Math.sin(a) * 7.2
          );
        } else if (mode === 1) {
          _v1.set(pos.x + 6.6, pos.y + 1.7, pos.z - 2.4);
        } else if (mode === 2) {
          _e2.set(0, _e1.y, 0, 'YXZ');
          _v1.set(0, 0.85, -7.4).applyEuler(_e2).add(pos);
        } else {
          _e2.set(0, _e1.y, 0, 'YXZ');
          _v1.set(5.8, 1.9, 4.8).applyEuler(_e2).add(pos);
        }

        const groundH = SIM.world.heightAt(_v1.x, _v1.z) + 0.6;
        if (_v1.y < groundH) _v1.y = groundH;

        const k = 1 - Math.exp(-dt * 3.5);
        rt.chaseCamera.position.lerp(_v1, k);
        rt.chaseCamera.lookAt(pos.x, pos.y + 0.2, pos.z);
        rt.activeCamera = rt.chaseCamera;
      },

      update(dt) {
        const rt = SIM.runtime;
        const rp = rt.replay;

        if (!rp.active) return;

        rp.playhead += dt * 60 * rp.speed;
        rp.camTime += dt;

        if (rp.playhead >= rp.total - 1) {
          this.stop(true);
          return;
        }

        this.applyFrame(rp.playhead);
        this.updateProps(dt);
        this.updateCamera(dt);
      }
    };
  })();

  SIM.physics = (function () {
    const _v1 = new THREE.Vector3();
    const _v2 = new THREE.Vector3();
    const _v3 = new THREE.Vector3();
    const _q1 = new THREE.Quaternion();
    const _q2 = new THREE.Quaternion();
    const _e = new THREE.Euler();
    const _up = new THREE.Vector3(0, 1, 0);
    const _targetAng = new THREE.Vector3();

    function expo(x) {
      return x * (0.62 + 0.38 * x * x);
    }

    function doCrash() {
      const st = SIM.state;
      if (st.crashed) return;

      st.crashed = true;
      st.armed = false;
      st.motor = 0;
      st.throttle = 0;

      if (SIM.audio && SIM.audio.crashSound) SIM.audio.crashSound();
    }

    function integrateQuaternion(dt) {
      const st = SIM.state;
      const half = dt * 0.5;

      _q1.set(
        st.angVel.x * half,
        st.angVel.y * half,
        st.angVel.z * half,
        0
      );

      _q2.copy(st.quat).multiply(_q1);

      st.quat.x += _q2.x;
      st.quat.y += _q2.y;
      st.quat.z += _q2.z;
      st.quat.w += _q2.w;
      st.quat.normalize();
    }

    function updateGates() {
      const st = SIM.state;
      const cfg = SIM.CONFIG;

      if (!SIM.runtime.started || st.crashed || !st.armed) return;

      const next = SIM.gates[st.nextGate];
      if (!next) return;

      const d = st.pos.distanceTo(next.pos);
      if (d < cfg.gateRadius * 0.72) {
        st.nextGate++;
        if (SIM.audio && SIM.audio.gateBeep) SIM.audio.gateBeep();

        if (st.nextGate >= SIM.gates.length) {
          st.nextGate = 0;
          st.lap++;

          const lapTime = st.time - st.lapStartTime;
          st.lastLap = lapTime;
          st.lapStartTime = st.time;

          if (st.bestLap <= 0 || lapTime < st.bestLap) {
            st.bestLap = lapTime;
            try {
              localStorage.setItem('fpv1_ultra_best', String(st.bestLap));
            } catch (err) {
              // ignore
            }
          }

          if (SIM.audio && SIM.audio.lapBeep) SIM.audio.lapBeep();
        }
      }
    }

    return {
      update(dt, t) {
        const st = SIM.state;
        const cfg = SIM.CONFIG;
        const rt = SIM.runtime;
        const u = SIM.utils;
        const keys = SIM.input.keys;

        rt.frame++;

        if (rt.started && !st.crashed) {
          st.time += dt;
        }

        if (!st.crashed) {
          if (st.armed && st.battery > 0) {
            if (keys.KeyW) st.throttle += dt * 1.16;
            if (keys.KeyS) st.throttle -= dt * 1.34;
            st.throttle = u.clamp(st.throttle, 0, 1);

            const yawRaw = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
            const pitchRaw = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
            const rollRaw = (keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0);

            _targetAng.set(
              expo(pitchRaw) * cfg.maxRate,
              expo(yawRaw) * cfg.yawRate,
              expo(rollRaw) * cfg.maxRate
            );
          } else {
            st.throttle = Math.max(0, st.throttle - dt * 2.5);
            _targetAng.set(0, 0, 0);
          }

          const spoolK = 1 - Math.exp(-dt * 7.5);
          st.motor += (st.throttle - st.motor) * spoolK;
          st.motor = u.clamp(st.motor, 0, 1);

          const angK = 1 - Math.exp(-dt * cfg.response);
          st.angVel.lerp(_targetAng, angK);

          const micro = st.armed ? 0.13 : 0.02;
          st.angVel.x += (Math.random() - 0.5) * micro * dt * 10;
          st.angVel.y += (Math.random() - 0.5) * micro * dt * 10;
          st.angVel.z += (Math.random() - 0.5) * micro * dt * 10;

          integrateQuaternion(dt);

          const groundH = SIM.world.heightAt(st.pos.x, st.pos.z);
          const agl = st.pos.y - groundH;

          _v1.copy(_up).applyQuaternion(st.quat);

          const batteryScale = 0.55 + 0.45 * (st.battery / 100);
          let thrust = st.motor * st.motor * cfg.maxThrust * batteryScale;

          if (agl < 1.4 && st.motor > 0.1) {
            thrust *= 1 + (1.4 - agl) * 0.08;
          }

          _v2.set(0, -cfg.gravity, 0);
          _v2.addScaledVector(_v1, thrust);

          const speed = st.vel.length();
          _v2.addScaledVector(st.vel, -(cfg.dragLinear + speed * cfg.dragQuad));

          st.wind.set(
            Math.sin(t * 0.33) * 2.6 + Math.sin(t * 1.6) * 0.8,
            Math.sin(t * 0.8) * 0.25,
            Math.cos(t * 0.26) * 2.8 + Math.cos(t * 1.2) * 0.7
          );

          _v3.copy(st.wind).sub(st.vel);
          _v2.addScaledVector(_v3, 0.02);

          st.vel.addScaledVector(_v2, dt);
          st.pos.addScaledVector(st.vel, dt);

          if (Math.abs(st.pos.x) > cfg.worldBound) {
            st.pos.x = u.clamp(st.pos.x, -cfg.worldBound, cfg.worldBound);
            st.vel.x *= -0.24;
          }

          if (Math.abs(st.pos.z) > cfg.worldBound) {
            st.pos.z = u.clamp(st.pos.z, -cfg.worldBound, cfg.worldBound);
            st.vel.z *= -0.24;
          }

          if (st.pos.y > cfg.altitudeLimit) {
            st.pos.y = cfg.altitudeLimit;
            st.vel.y *= -0.12;
          }

          const groundY = groundH + cfg.groundOffset;

          if (st.pos.y <= groundY) {
            _e.setFromQuaternion(st.quat, 'YXZ');

            const hardLanding = st.vel.y < -cfg.crashVerticalSpeed;
            const tilted = Math.abs(_e.x) > cfg.crashAngle || Math.abs(_e.z) > cfg.crashAngle;

            if (hardLanding || (tilted && st.vel.length() > 2.8)) {
              doCrash();
            } else {
              st.pos.y = groundY;

              if (st.vel.y < 0) {
                st.vel.y *= -0.18;
              }

              st.vel.x *= 0.9;
              st.vel.z *= 0.9;

              if (st.throttle < 0.045) {
                st.vel.multiplyScalar(0.86);
              }
            }
          }

          if (st.armed && st.battery > 0) {
            const angularEffort = st.angVel.lengthSq();
            const draw = 0.085 + st.motor * 2.75 + angularEffort * 0.02;
            st.battery = u.clamp(st.battery - draw * dt, 0, 100);

            st.current = 2 + st.motor * 92 + angularEffort * 1.2;
            st.voltage = 13.2 + (st.battery / 100) * 3.6 - st.motor * 1.15;
          } else {
            st.current = 0.2;
            st.voltage = 13.2 + (st.battery / 100) * 3.6;
          }

          if (st.battery <= 0 && st.armed) {
            st.armed = false;
          }
        } else {
          st.motor = Math.max(0, st.motor - dt * 3);
        }

        if (!isFinite(
          st.pos.x + st.pos.y + st.pos.z +
          st.vel.x + st.vel.y + st.vel.z +
          st.quat.x + st.quat.y + st.quat.z + st.quat.w
        )) {
          if (SIM.main && SIM.main.reset) {
            SIM.main.reset();
          }
        }

        st.distance = Math.sqrt(st.pos.x * st.pos.x + st.pos.z * st.pos.z);

        st.rssi = u.clamp(
          104 - st.distance * 0.052 - (st.crashed ? 42 : 0) - Math.random() * 4,
          3,
          100
        );

        st.link = u.clamp(st.rssi - Math.random() * 7, 1, 100);

        st.gps = st.crashed
          ? 0
          : u.clamp(Math.floor(7 + st.rssi / 10), 4, 14);

        updateGates();
      }
    };
  })();

  SIM.main = {
    ui: {},
    _sunOffset: null,
    _lastTime: 0,

    init() {
      const u = SIM.utils;

      this.ui.startOverlay = u.dom('startOverlay');
      this.ui.startBtn = u.dom('startBtn');
      this.ui.helpOverlay = u.dom('helpOverlay');
      this.ui.helpClose = u.dom('helpClose');
      this.ui.crashOverlay = u.dom('crashOverlay');
      this.ui.respawnBtn = u.dom('respawnBtn');
      this.ui.watchReplayBtn = u.dom('watchReplayBtn');
      this.ui.fullMapOverlay = u.dom('fullMapOverlay');
      this.ui.closeMapBtn = u.dom('closeMapBtn');
      this.ui.fatal = u.dom('fatal');
      this.ui.fatalText = u.dom('fatalText');

      this._sunOffset = new THREE.Vector3(120, 190, 90);

      let renderer;

      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          powerPreference: 'high-performance'
        });
      } catch (err) {
        showFatal('WebGL недоступен. Включи аппаратное ускорение или смени браузер.');
        return;
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;

      u.dom('app').appendChild(renderer.domElement);

      renderer.domElement.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        showFatal('WebGL-контекст потерян. Перезагрузи вкладку или уменьши нагрузку.');
      }, false);

      SIM.runtime.renderer = renderer;
      SIM.runtime.noiseCtx = u.dom('noiseCanvas').getContext('2d');

      const scene = new THREE.Scene();
      SIM.runtime.scene = scene;

      SIM.world.create(scene);
      SIM.drone.build(scene);
      SIM.minimap.init();
      SIM.hud.init();
      SIM.input.init();

      this.loadBestLap();
      this.bindButtons();
      this.reset();

      window.addEventListener('resize', this.onResize.bind(this));

      requestAnimationFrame(this.loop.bind(this));
    },

    bindButtons() {
      this.ui.startBtn.addEventListener('click', () => {
        this.ui.startBtn.blur();
        this.start();
      });

      this.ui.respawnBtn.addEventListener('click', () => {
        this.ui.respawnBtn.blur();
        this.reset();
      });

      this.ui.watchReplayBtn.addEventListener('click', () => {
        this.ui.watchReplayBtn.blur();
        this.watchReplay();
      });

      this.ui.helpClose.addEventListener('click', () => {
        this.ui.helpClose.blur();
        this.toggleHelp();
      });

      this.ui.closeMapBtn.addEventListener('click', () => {
        this.ui.closeMapBtn.blur();
        this.toggleMap();
      });
    },

    loadBestLap() {
      try {
        const v = parseFloat(localStorage.getItem('fpv1_ultra_best'));
        if (isFinite(v) && v > 0) {
          SIM.state.bestLap = v;
        }
      } catch (err) {
        // ignore
      }
    },

    start() {
      const rt = SIM.runtime;
      if (rt.started) return;

      rt.started = true;
      this.ui.startOverlay.style.display = 'none';

      if (SIM.audio && SIM.audio.init) SIM.audio.init();
      if (SIM.audio && SIM.audio.ctx && SIM.audio.ctx.state === 'suspended') {
        SIM.audio.ctx.resume();
      }

      if (SIM.audio && SIM.audio.uiBeep) SIM.audio.uiBeep();
      this.reset();
    },

    reset() {
      const st = SIM.state;
      const cfg = SIM.CONFIG;

      SIM.replay.stop(false);
      document.body.classList.remove('cinematic');

      st.armed = false;
      st.crashed = false;

      st.throttle = 0;
      st.motor = 0;

      st.battery = 100;
      st.voltage = 16.8;
      st.current = 0;

      st.time = 0;
      st.lapStartTime = 0;
      st.lap = 1;
      st.nextGate = 0;
      st.lastLap = 0;

      st.rssi = 100;
      st.link = 100;
      st.gps = 12;
      st.distance = 0;

      const groundH = SIM.world ? SIM.world.heightAt(0, 0) : 0;
      st.pos.set(0, groundH + cfg.groundOffset, 0);
      st.vel.set(0, 0, 0);
      st.quat.set(0, 0, 0, 1);
      st.angVel.set(0, 0, 0);
      st.wind.set(0, 0, 0);

      this.ui.crashOverlay.style.display = 'none';

      if (SIM.runtime.drone) {
        SIM.runtime.drone.position.copy(st.pos);
        SIM.runtime.drone.quaternion.copy(st.quat);
      }
    },

    showCrash() {
      this.ui.crashOverlay.style.display = 'flex';
    },

    watchReplay() {
      const rt = SIM.runtime;
      if (rt.replay.active) return;

      if (!SIM.replay.start(false)) {
        if (SIM.audio && SIM.audio.uiBeep) SIM.audio.uiBeep();
      }
    },

    toggleArm() {
      const st = SIM.state;
      const rt = SIM.runtime;

      if (!rt.started || st.crashed) return;
      if (!st.armed && st.battery <= 0) return;

      st.armed = !st.armed;

      if (st.armed) {
        st.throttle = 0;
        st.motor = 0;
        rt.recorder.frames.length = 0;

        if (SIM.audio && SIM.audio.ctx && SIM.audio.ctx.state === 'suspended') {
          SIM.audio.ctx.resume();
        }
      }

      if (SIM.audio && SIM.audio.uiBeep) SIM.audio.uiBeep();
    },

    toggleView() {
      const rt = SIM.runtime;
      rt.viewMode = rt.viewMode === 'fpv' ? 'chase' : 'fpv';
      if (SIM.audio && SIM.audio.uiBeep) SIM.audio.uiBeep();
    },

    toggleHelp() {
      const rt = SIM.runtime;
      rt.helpVisible = !rt.helpVisible;
      this.ui.helpOverlay.style.display = rt.helpVisible ? 'flex' : 'none';
    },

    toggleMap() {
      const rt = SIM.runtime;
      rt.mapVisible = !rt.mapVisible;
      this.ui.fullMapOverlay.style.display = rt.mapVisible ? 'flex' : 'none';

      if (rt.mapVisible) {
        SIM.minimap.drawFull();
      }
    },

    onResize() {
      const rt = SIM.runtime;
      const w = window.innerWidth;
      const h = window.innerHeight;

      rt.renderer.setSize(w, h);

      if (rt.fpvCamera) {
        rt.fpvCamera.aspect = w / h;
        rt.fpvCamera.updateProjectionMatrix();
      }

      if (rt.chaseCamera) {
        rt.chaseCamera.aspect = w / h;
        rt.chaseCamera.updateProjectionMatrix();
      }
    },

    updateNoise() {
      const rt = SIM.runtime;
      const st = SIM.state;
      const ctx = rt.noiseCtx;
      const canvas = ctx.canvas;

      const bad = st.rssi < 88 || st.crashed;

      if (rt.frame % 2 === 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (bad) {
          const amount = Math.floor(80 + (100 - st.rssi) * 2.2);

          for (let i = 0; i < amount; i++) {
            const a = Math.random() * 0.22;
            ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
            ctx.fillRect(
              Math.random() * canvas.width,
              Math.random() * canvas.height,
              1 + Math.random() * 2,
              1 + Math.random() * 2
            );
          }

          if (Math.random() < 0.18) {
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fillRect(
              0,
              Math.random() * canvas.height,
              canvas.width,
              1 + Math.random() * 3
            );
          }
        }
      }

      let noiseOpacity = SIM.utils.clamp((94 - st.rssi) / 75, 0, 0.82);
      if (st.crashed) noiseOpacity = Math.min(0.95, noiseOpacity + 0.2);

      canvas.style.opacity = noiseOpacity.toFixed(3);
    },

    updateSun() {
      const rt = SIM.runtime;
      const st = SIM.state;

      if (!rt.sun || !rt.sunTarget) return;

      rt.sun.position.copy(st.pos).add(this._sunOffset);
      rt.sunTarget.position.copy(st.pos);
    },

    updateFPS(now) {
      const rt = SIM.runtime;

      rt.fpsFrames++;

      if (now - rt.fpsTime >= 500) {
        rt.fps = rt.fpsFrames * 1000 / (now - rt.fpsTime);
        rt.fpsTime = now;
        rt.fpsFrames = 0;
      }
    },

    loop(now) {
      requestAnimationFrame(this.loop.bind(this));

      const rt = SIM.runtime;
      const st = SIM.state;

      let dt = (now - (this._lastTime || now)) / 1000;
      this._lastTime = now;

      if (dt > 0.05) dt = 0.05;
      if (dt <= 0) dt = 0.0001;

      rt.simTime += dt;
      this.updateFPS(now);

      if (rt.replay.active) {
        SIM.replay.update(dt);
        SIM.hud.update();
        if (SIM.audio && SIM.audio.update) SIM.audio.update();
        rt.renderer.render(rt.scene, rt.activeCamera);
        return;
      }

      if (rt.started && !st.crashed) {
        SIM.replay.record();
      }

      SIM.physics.update(dt, rt.simTime);

      if (st.crashed && rt.started && !rt.replay.active) {
        SIM.replay.record();
        if (!SIM.replay.start(true)) {
          this.showCrash();
        }
      }

      if (!rt.replay.active) {
        SIM.drone.updateVisuals(dt, rt.simTime);
        SIM.drone.updateCamera(dt);
        this.updateSun();
        this.updateNoise();
      } else {
        SIM.replay.update(dt);
      }

      SIM.hud.update();
      SIM.minimap.drawMini();

      if (rt.mapVisible) {
        SIM.minimap.drawFull();
      }

      if (SIM.audio && SIM.audio.update) SIM.audio.update();

      rt.renderer.render(rt.scene, rt.activeCamera);
    }
  };

  SIM.main.init();
})();
