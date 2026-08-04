(function () {
  'use strict';

  function showFatal(msg) {
    const fatal = document.getElementById('fatal');
    const fatalText = document.getElementById('fatalText');
    if (fatalText) fatalText.textContent = msg;
    if (fatal) fatal.style.display = 'flex';
  }

  if (typeof THREE === 'undefined') {
    showFatal('THREE.js не загрузился.');
    return;
  }

  const SIM = window.SIM = {};

  // ===== АЭРОДИНАМИЧЕСКИЕ КОНСТАНТЫ FP-1 =====
  SIM.CONFIG = {
    gravity: 9.81,

    // Самолёт
    maxThrust: 22.0,              // тяга толкающего пропеллера (Н/кг)
    wingArea: 1.4,                // условная площадь крыла
    liftCoeff: 0.042,             // подъёмная сила = v² * liftCoeff
    dragCoeff: 0.008,             // сопротивление
    inducedDrag: 0.0012,          // индуцированное сопротивление от подъёмной силы
    mass: 1.0,                    // условная масса

    // Управление
    pitchRate: 1.4,               // elevator
    rollRate: 2.2,                // ailerons
    yawRate: 0.9,                 // rudder
    response: 4.5,                // скорость реакции рулей
    autoCoordination: 0.35,       // rudder auto-coordinates with ailerons

    // Столл
    stallAoA: 0.44,               // ~25° — угол атаки стола
    stallSpeed: 14.0,             // м/с (~50 km/h) — ниже этой скорости подъёмной силы не хватает

    // Взлёт/посадка
    takeoffSpeed: 19.0,           // ~68 km/h — скорость отрыва
    groundFriction: 2.5,
    gearOffset: 0.45,             // высота шасси над землёй
    crashSpeed: 12.0,             // вертикальная скорость детонации
    crashAoA: 1.2,                // критический угол для детонации

    // Камера
    cameraTilt: -0.08,            // чуть вверх — видно горизонт при старте
    cameraForward: -0.9,          // в носу БПЛА

    // Мир
    gateRadius: 6.0,              // радиус waypoints
    worldBound: 1180,
    altitudeLimit: 1200,
    mapRange: 720,

    // Ресурсы
    fuelBurnRate: 0.4,            // % топлива в секунду при полном газу

    // Replay
    replayMaxFrames: 1200,
    replayUseFrames: 700
  };

  SIM.waypoints = []; // боевые точки вместо "гейтов"

  SIM.runtime = {
    renderer: null,
    scene: null,
    drone: null,         // на самом деле БПЛА FP-1
    fpvCamera: null,
    chaseCamera: null,
    activeCamera: null,
    sun: null,
    sunTarget: null,

    propGroups: [],
    propDirs: [],
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

    recorder: { frames: [], max: SIM.CONFIG.replayMaxFrames },
    replay: {
      active: false, playhead: 0, total: 0, offset: 0,
      speed: 0.34, camTime: 0, camForce: -1, motor: 0
    },

    stallWarning: false,
    stallFlash: 0
  };

  SIM.state = {
    armed: false,
    crashed: false,
    onGround: true,

    throttle: 0,
    motor: 0,

    fuel: 100,
    voltage: 16.8,
    current: 0,

    time: 0,
    missionStartTime: 0,
    range: 1,
    nextWaypoint: 0,
    bestRange: 0,
    lastRange: 0,

    rssi: 100,
    link: 100,
    gps: 12,
    distance: 0,

    pos: new THREE.Vector3(0, 0.5, 0),
    vel: new THREE.Vector3(0, 0, 0),
    quat: new THREE.Quaternion(0, 0, 0, 1),
    angVel: new THREE.Vector3(0, 0, 0),
    wind: new THREE.Vector3(0, 0, 0)
  };

  SIM.utils = {
    clamp(v, a, b) { return Math.max(a, Math.min(b, v)); },
    rand(a, b) { return a + Math.random() * (b - a); },
    smoothstep(e0, e1, x) {
      const t = SIM.utils.clamp((x - e0) / (e1 - e0), 0, 1);
      return t * t * (3 - 2 * t);
    },
    formatTime(sec) {
      if (!isFinite(sec) || sec <= 0) return '--:--.---';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      const ms = Math.floor((sec % 1) * 1000);
      return String(m).padStart(2,'0') + ':' +
             String(s).padStart(2,'0') + '.' +
             String(ms).padStart(3,'0');
    },
    dom(id) { return document.getElementById(id); }
  };

  // ===== INPUT =====
  SIM.input = {
    keys: Object.create(null),
    init() {
      window.addEventListener('keydown', this.onKeyDown.bind(this), { passive: false });
      window.addEventListener('keyup', this.onKeyUp.bind(this), { passive: false });
      window.addEventListener('blur', this.clear.bind(this));
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.clear(); });
    },
    clear() {
      Object.keys(this.keys).forEach((k) => { this.keys[k] = false; });
    },
    onKeyDown(e) {
      const blocked = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (blocked.indexOf(e.code) !== -1) e.preventDefault();

      this.keys[e.code] = true;
      if (e.repeat) return;

      const main = SIM.main;
      const rt = SIM.runtime;
      if (!main || !rt) return;

      if (rt.replay.active) {
        if (e.code === 'Space' || e.code === 'Escape') SIM.replay.stop(true);
        if (e.code === 'KeyR') { SIM.replay.stop(false); main.reset(); }
        if (e.code === 'KeyC') rt.replay.camForce = (rt.replay.camForce + 1) % 4;
        return;
      }

      if (e.code === 'Enter' && !rt.started) { main.start(); return; }
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
    onKeyUp(e) { this.keys[e.code] = false; }
  };

  // ===== WORLD (terrain + waypoints) =====
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
      const lake = -10 * Math.exp(-(((x-310)**2 + (z-260)**2) / 12000));
      const mountain = 24 * Math.exp(-(((x+430)**2 + (z-380)**2) / 52000));
      return h + lake + mountain;
    },

    create(scene) {
      SIM.runtime.scene = scene;
      scene.background = new THREE.Color(0x8fd2ff);
      scene.fog = new THREE.Fog(0x9ed8ff, 90, 1020);

      this.addLights(scene);
      this.addTerrain(scene);
      this.addWater(scene);
      this.addRunway(scene);
      this.addTrees(scene);
      this.addBuildings(scene);
      this.addClouds(scene);
      this.addWaypoints(scene);
      this.addRunwayLights(scene);
      this.addWindsock(scene);
    },

    addLights(scene) {
      const rt = SIM.runtime;
      scene.add(new THREE.HemisphereLight(0xcfefff, 0x223322, 0.92));

      const sun = new THREE.DirectionalLight(0xfff2cc, 1.18);
      sun.position.set(130, 190, 90);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -240; sun.shadow.camera.right = 240;
      sun.shadow.camera.top = 240;   sun.shadow.camera.bottom = -240;
      sun.shadow.camera.near = 10;   sun.shadow.camera.far = 800;
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
      const size = 2500, segments = 170;
      const geo = new THREE.PlaneGeometry(size, size, segments, segments);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        const h = this.heightAt(x, z);
        pos.setY(i, h);
        let r, g, b;
        const v = 0.9 + Math.random() * 0.2;
        if (h < -1.3) { r=0.06; g=0.16; b=0.22; }
        else if (h < 0.35) { r=0.48; g=0.44; b=0.26; }
        else if (h < 6) { r=0.16; g=0.36; b=0.14; }
        else if (h < 14) { r=0.24; g=0.30; b=0.14; }
        else if (h < 24) { r=0.35; g=0.30; b=0.24; }
        else { r=0.75; g=0.76; b=0.78; }
        colors[i*3+0] = r*v; colors[i*3+1] = g*v; colors[i*3+2] = b*v;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 1, metalness: 0
      }));
      terrain.receiveShadow = true;
      scene.add(terrain);
    },

    addWater(scene) {
      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(2500, 2500),
        new THREE.MeshStandardMaterial({
          color: 0x1663a8, transparent: true, opacity: 0.82,
          roughness: 0.14, metalness: 0.35
        })
      );
      water.rotation.x = -Math.PI / 2;
      water.position.y = -1.35;
      scene.add(water);
    },

    addRunway(scene) {
      const ac = document.createElement('canvas');
      ac.width = 256; ac.height = 256;
      const g = ac.getContext('2d');
      g.fillStyle = '#25282c'; g.fillRect(0,0,256,256);
      for (let i = 0; i < 3600; i++) {
        const v = 18 + Math.random() * 48;
        g.fillStyle = `rgba(${v},${v+2},${v+5},${0.08+Math.random()*0.22})`;
        g.fillRect(Math.random()*256, Math.random()*256, 1+Math.random()*2, 1+Math.random()*2);
      }
      const tex = new THREE.CanvasTexture(ac);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(2, 18);

      const runway = new THREE.Mesh(
        new THREE.PlaneGeometry(32, 450),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0.02 })
      );
      runway.rotation.x = -Math.PI / 2;
      runway.position.set(0, 0.02, -100);
      runway.receiveShadow = true;
      scene.add(runway);

      const cl = new THREE.Mesh(
        new THREE.PlaneGeometry(0.55, 450),
        new THREE.MeshBasicMaterial({ color: 0xd8e6e2, transparent: true, opacity: 0.65 })
      );
      cl.rotation.x = -Math.PI / 2;
      cl.position.set(0, 0.03, -100);
      scene.add(cl);

      // Взлётная точка FP-1
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(6, 48),
        new THREE.MeshStandardMaterial({ color: 0x101317, roughness: 0.7, metalness: 0.18 })
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(0, 0.03, 80);
      pad.receiveShadow = true;
      scene.add(pad);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(5.3, 6, 64),
        new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 0.04, 80);
      scene.add(ring);
    },

    addTrees(scene) {
      const count = 340;
      const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.25, 7);
      const leafGeo = new THREE.ConeGeometry(1.25, 3.2, 8);
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
      const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f7d32, roughness: 0.9 });
      const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
      const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, count);
      trunkMesh.castShadow = true; leafMesh.castShadow = true;

      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const e = new THREE.Euler();

      let placed = 0, attempts = 0;
      while (placed < count && attempts < count * 10) {
        attempts++;
        const x = SIM.utils.rand(-980, 980), z = SIM.utils.rand(-980, 980);
        if (Math.abs(x) < 40 && z > -325 && z < 145) continue;
        const h = this.heightAt(x, z);
        if (h < 0.15 || h > 24) continue;
        const scale = SIM.utils.rand(0.75, 2.4);
        q.setFromEuler(e.set(0, Math.random()*Math.PI*2, 0));
        p.set(x, h + 0.62*scale, z); s.setScalar(scale);
        m.compose(p, q, s); trunkMesh.setMatrixAt(placed, m);
        p.set(x, h + 2.35*scale, z);
        m.compose(p, q, s); leafMesh.setMatrixAt(placed, m);
        placed++;
      }
      trunkMesh.count = leafMesh.count = placed;
      trunkMesh.instanceMatrix.needsUpdate = leafMesh.instanceMatrix.needsUpdate = true;
      scene.add(trunkMesh); scene.add(leafMesh);
    },

    addBuildings(scene) {
      const bc = document.createElement('canvas');
      bc.width = 256; bc.height = 512;
      const g = bc.getContext('2d');
      g.fillStyle = '#151a21'; g.fillRect(0,0,256,512);
      for (let y = 18; y < 490; y += 28) {
        for (let x = 14; x < 234; x += 30) {
          g.fillStyle = Math.random() < 0.34
            ? `rgba(${150+Math.random()*105},${210+Math.random()*45},${120+Math.random()*135},${0.65+Math.random()*0.35})`
            : 'rgba(25,35,48,0.95)';
          g.fillRect(x, y, 18, 16);
        }
      }
      const tex = new THREE.CanvasTexture(bc);
      const roofMat = new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.82, metalness: 0.12 });

      for (let i = 0; i < 18; i++) {
        const a = SIM.utils.rand(0, Math.PI*2);
        const d = SIM.utils.rand(170, 520);
        const x = Math.cos(a)*d, z = Math.sin(a)*d;
        if (Math.abs(x) < 60 && z > -360 && z < 180) continue;
        const hGround = this.heightAt(x, z);
        if (hGround < 0.3 || hGround > 18) continue;
        const w = SIM.utils.rand(14, 32);
        const h = SIM.utils.rand(22, 82);
        const depth = SIM.utils.rand(14, 30);
        const t = tex.clone(); t.needsUpdate = true;
        t.repeat.set(Math.max(1, w/18), Math.max(1, h/28));
        const wallMat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.72, metalness: 0.18 });
        const b = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, depth),
          [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat]
        );
        b.position.set(x, hGround + h/2 - 0.5, z);
        b.castShadow = b.receiveShadow = true;
        scene.add(b);
      }
    },

    addClouds(scene) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, transparent: true, opacity: 0.46, roughness: 1, metalness: 0
      });
      for (let i = 0; i < 15; i++) {
        const cloud = new THREE.Group();
        const puffs = 3 + Math.floor(Math.random()*4);
        for (let j = 0; j < puffs; j++) {
          const s = SIM.utils.rand(10, 32);
          const puff = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 10), mat);
          puff.position.set(SIM.utils.rand(-28,28), SIM.utils.rand(-6,10), SIM.utils.rand(-18,18));
          cloud.add(puff);
        }
        cloud.position.set(SIM.utils.rand(-900,900), SIM.utils.rand(150,260), SIM.utils.rand(-900,900));
        scene.add(cloud);
      }
    },

    addWaypoints(scene) {
      SIM.waypoints = [];
      const specs = [
        // [x, z, altAboveGround, radius] — боевые точки
        [0, 50, 80, 6],
        [120, -60, 120, 8],
        [250, -150, 180, 10],
        [380, -80, 220, 12],
        [420, 100, 180, 10],
        [300, 260, 140, 8],
        [100, 320, 100, 8],
        [-80, 200, 80, 8]
      ];
      specs.forEach((s) => this.createWaypoint(scene, s[0], s[1], s[2], s[3]));
    },

    createWaypoint(scene, x, z, aboveGround, radius) {
      const h = this.heightAt(x, z);
      const y = h + aboveGround;

      const group = new THREE.Group();

      const ringMat = new THREE.MeshStandardMaterial({
        color: 0x0b0e13,
        emissive: 0xffaa00,
        emissiveIntensity: 0.45,
        roughness: 0.26,
        metalness: 0.72
      });

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.45, 12, 48),
        ringMat
      );
      ring.castShadow = true;
      group.add(ring);

      // Вертикальный столб света
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xffaa00, transparent: true, opacity: 0.08, side: THREE.DoubleSide
      });
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(radius*0.9, radius*0.9, aboveGround*2, 16, 1, true),
        beamMat
      );
      beam.position.y = -aboveGround;
      group.add(beam);

      group.position.set(x, y, z);
      scene.add(group);

      SIM.waypoints.push({ group, ring, mat: ringMat, pos: group.position, x, z, alt: y });
    },

    addRunwayLights(scene) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffaa44 });
      const geo = new THREE.SphereGeometry(0.22, 8, 8);
      for (let z = -320; z <= 120; z += 25) {
        const left = new THREE.Mesh(geo, mat);
        left.position.set(-16.7, 0.16, z);
        scene.add(left);
        const right = new THREE.Mesh(geo, mat);
        right.position.set(16.7, 0.16, z);
        scene.add(right);
      }
    },

    addWindsock(scene) {
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x8f98a3, roughness: 0.35, metalness: 0.8 });
      const sockMat = new THREE.MeshStandardMaterial({
        color: 0xff7a1a, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide
      });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5.5, 10), poleMat);
      pole.position.set(22, 2.75, 90); pole.castShadow = true; scene.add(pole);
      const sock = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.2, 10, 1, true), sockMat);
      sock.rotation.z = Math.PI/2; sock.position.set(23.2, 5.15, 90); sock.castShadow = true; scene.add(sock);
    }
  };

  // ===== FP-1 БПЛА (модель с фиксированным крылом) =====
  SIM.drone = (function () {
    const _v1 = new THREE.Vector3();
    const _e1 = new THREE.Euler();
    const _e2 = new THREE.Euler();

    function makeBodyTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const g = c.getContext('2d');
      // Камуфляж
      g.fillStyle = '#3a4238'; g.fillRect(0,0,256,256);
      const camoColors = ['#2d332a', '#4a5342', '#262b22', '#52594c', '#1f231c'];
      for (let i = 0; i < 80; i++) {
        g.fillStyle = camoColors[Math.floor(Math.random()*camoColors.length)];
        g.globalAlpha = 0.4 + Math.random()*0.5;
        const x = Math.random()*256, y = Math.random()*256;
        const w = 20+Math.random()*60, h = 10+Math.random()*40;
        g.beginPath();
        g.ellipse(x, y, w, h, Math.random()*Math.PI, 0, Math.PI*2);
        g.fill();
      }
      g.globalAlpha = 1;
      const tex = new THREE.CanvasTexture(c);
      return tex;
    }

    return {
      build(scene) {
        const rt = SIM.runtime;
        const cfg = SIM.CONFIG;

        const bpla = new THREE.Group();
        const camoTex = makeBodyTexture();

        const bodyMat = new THREE.MeshStandardMaterial({
          map: camoTex, roughness: 0.6, metalness: 0.1
        });
        const darkMat = new THREE.MeshStandardMaterial({
          color: 0x1a1d18, roughness: 0.5, metalness: 0.3
        });
        const metalMat = new THREE.MeshStandardMaterial({
          color: 0x8a8a8a, roughness: 0.25, metalness: 0.9
        });
        const warheadMat = new THREE.MeshStandardMaterial({
          color: 0x2a1a0a, roughness: 0.4, metalness: 0.5,
          emissive: 0x331100, emissiveIntensity: 0.15
        });
        const glassMat = new THREE.MeshStandardMaterial({
          color: 0x05080a, roughness: 0.08, metalness: 0.9
        });

        // === Фюзеляж (длинный, сигарообразный) ===
        const fuselageGeo = new THREE.CylinderGeometry(0.22, 0.18, 2.2, 16);
        fuselageGeo.rotateZ(Math.PI / 2);
        const fuselage = new THREE.Mesh(fuselageGeo, bodyMat);
        fuselage.castShadow = true;
        bpla.add(fuselage);

        // Нос — конус с боевой частью
        const noseCone = new THREE.Mesh(
          new THREE.ConeGeometry(0.22, 0.7, 16),
          warheadMat
        );
        noseCone.rotation.z = -Math.PI / 2;
        noseCone.position.x = -1.45;
        noseCone.castShadow = true;
        bpla.add(noseCone);

        // Обтекатель камеры
        const camDome = new THREE.Mesh(
          new THREE.SphereGeometry(0.12, 14, 10, 0, Math.PI*2, 0, Math.PI/2),
          glassMat
        );
        camDome.rotation.z = -Math.PI / 2;
        camDome.position.set(-1.25, 0.05, 0);
        bpla.add(camDome);

        // === Дельта-крыло ===
        const wingShape = new THREE.Shape();
        wingShape.moveTo(0, 0);
        wingShape.lineTo(-0.8, 1.6);
        wingShape.lineTo(-0.3, 1.6);
        wingShape.lineTo(0.4, 0);
        wingShape.closePath();

        const wingExtrudeSettings = { depth: 0.04, bevelEnabled: false };
        const wingGeo = new THREE.ExtrudeGeometry(wingShape, wingExtrudeSettings);

        const wingRight = new THREE.Mesh(wingGeo, bodyMat);
        wingRight.rotation.x = -Math.PI / 2;
        wingRight.position.set(0, 0.02, 0);
        wingRight.castShadow = true;
        bpla.add(wingRight);

        const wingLeft = new THREE.Mesh(wingGeo, bodyMat);
        wingLeft.rotation.x = Math.PI / 2;
        wingLeft.rotation.y = Math.PI;
        wingLeft.position.set(0, 0.02, 0);
        wingLeft.castShadow = true;
        bpla.add(wingLeft);

        // === V-образное хвостовое оперение ===
        const tailShape = new THREE.Shape();
        tailShape.moveTo(0, 0);
        tailShape.lineTo(-0.4, 0.7);
        tailShape.lineTo(-0.1, 0.7);
        tailShape.lineTo(0.2, 0);
        tailShape.closePath();
        const tailGeo = new THREE.ExtrudeGeometry(tailShape, { depth: 0.03, bevelEnabled: false });

        const tailR = new THREE.Mesh(tailGeo, bodyMat);
        tailR.position.set(0.9, 0.02, 0);
        tailR.rotation.z = -0.45;
        tailR.rotation.x = -0.35;
        tailR.castShadow = true;
        bpla.add(tailR);

        const tailL = new THREE.Mesh(tailGeo, bodyMat);
        tailL.position.set(0.9, 0.02, 0);
        tailL.rotation.z = 0.45;
        tailL.rotation.y = Math.PI;
        tailL.rotation.x = 0.35;
        tailL.castShadow = true;
        bpla.add(tailL);

        // === Моторный блок сзади (толкающий пропеллер) ===
        const motorBlock = new THREE.Mesh(
          new THREE.CylinderGeometry(0.14, 0.18, 0.35, 14),
          darkMat
        );
        motorBlock.rotation.z = Math.PI / 2;
        motorBlock.position.x = 1.25;
        motorBlock.castShadow = true;
        bpla.add(motorBlock);

        // Вал пропеллера
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.015, 0.15, 8),
          metalMat
        );
        shaft.rotation.z = Math.PI / 2;
        shaft.position.x = 1.5;
        bpla.add(shaft);

        // Пропеллер (толкатель)
        const propGroup = new THREE.Group();
        propGroup.position.x = 1.58;

        const hubMat = new THREE.MeshStandardMaterial({ color: 0xdfe5ea, roughness: 0.2, metalness: 0.9 });
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.05, 12), hubMat);
        hub.rotation.z = Math.PI / 2;
        propGroup.add(hub);

        const bladeMat = new THREE.MeshStandardMaterial({
          color: 0x2a2a2a, roughness: 0.35, metalness: 0.4
        });
        for (let i = 0; i < 3; i++) {
          const blade = new THREE.Mesh(
            new THREE.BoxGeometry(0.02, 0.4, 0.06),
            bladeMat
          );
          blade.rotation.x = (i * Math.PI * 2) / 3;
          propGroup.add(blade);
        }

        const propBlurMat = new THREE.MeshBasicMaterial({
          color: 0xaaaaaa, transparent: true, opacity: 0, side: THREE.DoubleSide
        });
        const blurDisc = new THREE.Mesh(
          new THREE.CircleGeometry(0.22, 24),
          propBlurMat
        );
        blurDisc.rotation.y = Math.PI / 2;
        propGroup.add(blurDisc);

        bpla.add(propGroup);
        rt.propGroups = [propGroup];
        rt.propDirs = [1];
        rt.propBlurMat = propBlurMat;

        // === Антенны (GPS, радио) ===
        const antMat = new THREE.MeshStandardMaterial({ color: 0x20242a, roughness: 0.5 });
        const ant1 = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.18, 6), antMat);
        ant1.position.set(-0.3, 0.24, 0);
        bpla.add(ant1);
        const ant2 = ant1.clone();
        ant2.position.set(0.4, 0.24, 0);
        bpla.add(ant2);

        // === Шасси (простые стойки для взлёта) ===
        const gearMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5, metalness: 0.6 });
        const noseGear = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.35, 8), gearMat);
        noseGear.position.set(-0.8, -0.35, 0);
        bpla.add(noseGear);
        const noseWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 10), darkMat);
        noseWheel.rotation.x = Math.PI / 2;
        noseWheel.position.set(-0.8, -0.52, 0);
        bpla.add(noseWheel);

        const mainGearR = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.35, 8), gearMat);
        mainGearR.position.set(0.2, -0.35, 0.5);
        bpla.add(mainGearR);
        const mainWheelR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 10), darkMat);
        mainWheelR.rotation.x = Math.PI / 2;
        mainWheelR.position.set(0.2, -0.52, 0.5);
        bpla.add(mainWheelR);

        const mainGearL = mainGearR.clone();
        mainGearL.position.set(0.2, -0.35, -0.5);
        bpla.add(mainGearL);
        const mainWheelL = mainWheelR.clone();
        mainWheelL.position.set(0.2, -0.52, -0.5);
        bpla.add(mainWheelL);

        // LED навигации
        const ledGeo = new THREE.SphereGeometry(0.03, 8, 8);
        const redLedMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2222, emissiveIntensity: 0.3 });
        const greenLedMat = new THREE.MeshStandardMaterial({ color: 0x003311, emissive: 0x00ff66, emissiveIntensity: 0.3 });
        const whiteLedMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xffffff, emissiveIntensity: 0.3 });

        const redLed = new THREE.Mesh(ledGeo, redLedMat);
        redLed.position.set(-0.15, 0.02, -1.62); bpla.add(redLed);
        const greenLed = new THREE.Mesh(ledGeo, greenLedMat);
        greenLed.position.set(-0.15, 0.02, 1.62); bpla.add(greenLed);
        const whiteLed = new THREE.Mesh(ledGeo, whiteLedMat);
        whiteLed.position.set(1.2, 0.18, 0); bpla.add(whiteLed);

        rt.ledMats = [redLedMat, greenLedMat, whiteLedMat];

        // FPV-камера в носу (боевая часть)
        const fpvCamera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 2200);
        fpvCamera.position.set(cfg.cameraForward, 0.05, 0);
        fpvCamera.rotation.set(0, Math.PI, cfg.cameraTilt);
        bpla.add(fpvCamera);

        const chaseCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2500);
        chaseCamera.position.set(0, 4, 10);

        rt.drone = bpla;
        rt.fpvCamera = fpvCamera;
        rt.chaseCamera = chaseCamera;
        rt.activeCamera = fpvCamera;

        scene.add(bpla);
      },

      updateVisuals(dt, t) {
        const rt = SIM.runtime;
        const st = SIM.state;
        const cfg = SIM.CONFIG;

        rt.drone.position.copy(st.pos);
        rt.drone.quaternion.copy(st.quat);

        const spin = st.armed ? 40 + st.motor * 450 : 0;
        for (let i = 0; i < rt.propGroups.length; i++) {
          rt.propGroups[i].rotation.x += spin * dt * (rt.propDirs ? rt.propDirs[i] : 1);
        }

        if (rt.propBlurMat) {
          rt.propBlurMat.opacity = SIM.utils.clamp(st.motor * 0.5, 0, 0.55);
        }

        // LED мерцание
        if (rt.ledMats.length >= 3) {
          const blink = Math.sin(t * 8) > 0 ? 1.8 : 0.25;
          rt.ledMats[0].emissiveIntensity = st.armed ? blink : 0.15;
          rt.ledMats[1].emissiveIntensity = st.armed ? blink : 0.15;
          rt.ledMats[2].emissiveIntensity = st.armed ? 1.4 : 0.2;
        }

        const speed = st.vel.length();
        const shake = (st.armed ? 0.0015 + st.motor * 0.003 : 0.0004)
          + st.angVel.length() * 0.0012
          + (st.crashed ? 0.03 : 0);

        rt.fpvCamera.position.set(
          cfg.cameraForward + (Math.random() - 0.5) * shake,
          0.05 + (Math.random() - 0.5) * shake,
          (Math.random() - 0.5) * shake
        );

        rt.fpvCamera.rotation.x = (Math.random() - 0.5) * shake * 1.5;
        rt.fpvCamera.rotation.z = cfg.cameraTilt + (Math.random() - 0.5) * shake * 1.5;

        const targetFov = SIM.utils.clamp(88 + speed * 0.15 + st.motor * 6, 88, 110);
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

        _v1.set(3.5, 2.4, 0).applyEuler(_e2).add(st.pos);

        const k = 1 - Math.exp(-dt * 4.8);
        rt.chaseCamera.position.lerp(_v1, k);

        const groundH = SIM.world.heightAt(rt.chaseCamera.position.x, rt.chaseCamera.position.z) + 0.85;
        if (rt.chaseCamera.position.y < groundH) rt.chaseCamera.position.y = groundH;

        rt.chaseCamera.lookAt(st.pos.x, st.pos.y + 0.35, st.pos.z);
      }
    };
  })();

  // ===== MINIMAP =====
  SIM.minimap = {
    terrainCanvas: null,
    _euler: null,
    init() {
      this._euler = new THREE.Euler();
      this.terrainCanvas = this.makeTerrainCanvas(SIM.CONFIG.mapRange, 256);
    },
    makeTerrainCanvas(range, size) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(size, size);
      const data = img.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const wx = (x / size * 2 - 1) * range;
          const wz = (y / size * 2 - 1) * range;
          const h = SIM.world.heightAt(wx, wz);
          let r, g, b;
          if (h < -1.3) { r=16; g=48; b=66; }
          else if (h < 0.35) { r=122; g=112; b=66; }
          else if (h < 6) { r=36; g=86; b=34; }
          else if (h < 14) { r=58; g=74; b=34; }
          else if (h < 24) { r=88; g=74; b=58; }
          else { r=186; g=190; b=196; }
          const idx = (y*size+x)*4;
          data[idx]=r; data[idx+1]=g; data[idx+2]=b; data[idx+3]=255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    },
    drawMini() { this.draw(SIM.utils.dom('minimapCanvas'), false); },
    drawFull() { this.draw(SIM.utils.dom('fullMapCanvas'), true); },
    draw(canvas, detailed) {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const size = canvas.width;
      const range = SIM.CONFIG.mapRange;
      const st = SIM.state;
      const rt = SIM.runtime;

      ctx.clearRect(0, 0, size, size);
      if (this.terrainCanvas) ctx.drawImage(this.terrainCanvas, 0, 0, size, size);
      else { ctx.fillStyle = '#08120c'; ctx.fillRect(0, 0, size, size); }

      const scale = size / (range * 2);
      const toPx = (x) => (x + range) * scale;

      if (detailed) {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 12; i++) {
          const p = i*size/12;
          ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,size); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(size,p); ctx.stroke();
        }
      }

      // ВПП
      ctx.fillStyle = 'rgba(30,30,30,0.85)';
      ctx.fillRect(toPx(-16), toPx(-320), 32*scale, 450*scale);

      // Waypoints
      for (let i = 0; i < SIM.waypoints.length; i++) {
        const w = SIM.waypoints[i];
        const x = toPx(w.x), y = toPx(w.z);
        const isNext = i === st.nextWaypoint;
        const passed = i < st.nextWaypoint;
        const pulse = isNext ? 1 + Math.sin(rt.simTime*6)*0.25 : 1;

        // Линия к следующему
        if (isNext || (passed && i === st.nextWaypoint - 1)) {
          const nextW = i < SIM.waypoints.length - 1 ? SIM.waypoints[i+1] : null;
          if (nextW && isNext) {
            ctx.strokeStyle = 'rgba(255,170,0,0.35)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(toPx(nextW.x), toPx(nextW.z));
            ctx.stroke();
          }
        }

        ctx.beginPath();
        ctx.arc(x, y, (detailed ? 7 : 5) * pulse, 0, Math.PI*2);

        if (isNext) {
          ctx.fillStyle = 'rgba(255,170,0,0.95)';
          ctx.strokeStyle = 'rgba(255,170,0,0.95)';
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
          ctx.fillText(String(i+1), x + 8, y - 8);
        }
      }

      this._euler.setFromQuaternion(st.quat, 'YXZ');

      ctx.save();
      ctx.translate(toPx(st.pos.x), toPx(st.pos.z));
      ctx.rotate(-this._euler.y);

      // Треугольник БПЛА (нос вперёд по -Z в локальной системе)
      ctx.beginPath();
      ctx.moveTo(0, detailed ? -10 : -8);
      ctx.lineTo(detailed ? 5 : 4, detailed ? 8 : 7);
      ctx.lineTo(detailed ? -5 : -4, detailed ? 8 : 7);
      ctx.closePath();

      ctx.fillStyle = st.armed ? 'rgba(255,200,0,0.98)' : 'rgba(255,93,93,0.95)';
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 12;
      ctx.fill();

      ctx.restore();

      if (detailed) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '14px Consolas, monospace';
        ctx.fillText('N', size-18, 18);
        ctx.fillText('RANGE ~ '+range+'m', 12, size-12);
        ctx.fillText('WP '+(st.nextWaypoint+1)+'/'+SIM.waypoints.length, 12, 20);
        ctx.fillText('RANGE '+st.range, 12, 38);
      }
    }
  };

  // ===== HUD =====
  SIM.hud = {
    els: {},
    _euler: null,
    init() {
      this._euler = new THREE.Euler();
      ['armed','mode','timer','gate','lap','best','heading','fps',
       'alt','spd','vs','thr','thrFill','batteryFill','voltage','rssi','gps',
       'horizonInner'].forEach((id) => { this.els[id] = SIM.utils.dom(id); });
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

      if (els.heading) els.heading.textContent = String(heading).padStart(3,'0') + '°';
      if (els.fps) els.fps.textContent = Math.round(rt.fps) + ' FPS';

      if (els.horizonInner) {
        els.horizonInner.style.transform =
          'translate(-50%,-50%) rotate('+rollDeg.toFixed(2)+'deg) translateY('+(pitchDeg*2.8).toFixed(2)+'px)';
      }

      const agl = Math.max(0, st.pos.y - SIM.world.heightAt(st.pos.x, st.pos.z));
      const speedKmh = st.vel.length() * 3.6;

      if (els.alt) els.alt.textContent = agl.toFixed(1) + ' m';
      if (els.spd) els.spd.textContent = Math.round(speedKmh) + ' km/h';
      if (els.vs) els.vs.textContent = st.vel.y.toFixed(1) + ' m/s';
      if (els.thr) els.thr.textContent = Math.round(st.throttle*100) + '%';

      if (els.thrFill) els.thrFill.style.width = (st.throttle*100).toFixed(0) + '%';
      if (els.batteryFill) {
        els.batteryFill.style.width = st.fuel.toFixed(0) + '%';
        els.batteryFill.className = st.fuel > 40 ? '' : (st.fuel > 18 ? 'warn' : 'bad');
      }

      if (els.voltage) els.voltage.textContent = 'FUEL ' + st.fuel.toFixed(0) + '%';
      if (els.rssi) els.rssi.textContent = 'LINK ' + Math.round(st.link) + '%';
      if (els.gps) els.gps.textContent = 'GPS ' + Math.round(st.gps) + ' SAT';

      if (els.timer) els.timer.textContent = u.formatTime(st.time);
      if (els.best) els.best.textContent = 'BEST ' + u.formatTime(st.bestRange);
      if (els.gate) els.gate.textContent = 'WP ' + (st.nextWaypoint+1) + '/' + (SIM.waypoints.length || 1);
      if (els.lap) els.lap.textContent = 'RANGE ' + st.range;

      if (els.armed) {
        els.armed.textContent = st.armed ? 'ENGINE ON' : 'STANDBY';
        els.armed.className = 'chip ' + (st.armed ? 'armed' : 'disarmed');
      }
      if (els.mode) els.mode.textContent = rt.viewMode === 'fpv' ? 'NOSE' : 'CHASE';

      // Stall warning: мигание horizon
      const horizon = SIM.utils.dom('horizonWrap');
      if (horizon) {
        horizon.style.borderColor = rt.stallWarning
          ? 'rgba(255,80,0,'+(0.4+Math.sin(rt.simTime*20)*0.4).toFixed(2)+')'
          : 'rgba(170,255,220,0.24)';
      }
    }
  };

  // ===== REPLAY (без изменений) =====
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
          t: rt.simTime, x: st.pos.x, y: st.pos.y, z: st.pos.z,
          qx: st.quat.x, qy: st.quat.y, qz: st.quat.z, qw: st.quat.w,
          m: st.motor
        });
        if (rec.frames.length > rec.max) rec.frames.shift();
      },
      getFrame(i) { return SIM.runtime.recorder.frames[i] || null; },
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
        rp.camTime = 0; rp.camForce = -1; rp.motor = 0;
        document.body.classList.add('cinematic');
        SIM.utils.dom('crashOverlay').style.display = 'none';
        SIM.utils.dom('replayBadge').textContent = auto ? 'IMPACT REPLAY // CINEMATIC' : 'REPLAY // CINEMATIC';
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
        if (rt.drone) { rt.drone.position.copy(st.pos); rt.drone.quaternion.copy(st.quat); }
        if (st.crashed && showCrashIfCrashed !== false && SIM.main) SIM.main.showCrash();
      },
      applyFrame(playhead) {
        const rt = SIM.runtime;
        const rp = rt.replay;
        const i = Math.floor(playhead);
        const frac = playhead - i;
        const a = this.getFrame(rp.offset + i);
        const b = this.getFrame(rp.offset + Math.min(i+1, rp.total-1));
        if (!a || !b) return;
        _v1.set(a.x, a.y, a.z); _v2.set(b.x, b.y, b.z);
        rt.drone.position.lerpVectors(_v1, _v2, frac);
        _q1.set(a.qx, a.qy, a.qz, a.qw); _q2.set(b.qx, b.qy, b.qz, b.qw);
        rt.drone.quaternion.copy(_q1).slerp(_q2, frac);
        rp.motor = a.m + (b.m - a.m) * frac;
        if (rt.propBlurMat) rt.propBlurMat.opacity = SIM.utils.clamp(rp.motor*0.45, 0, 0.5);
      },
      updateProps(dt) {
        const rt = SIM.runtime;
        const rp = rt.replay;
        const spin = 40 + rp.motor * 450;
        for (let i = 0; i < rt.propGroups.length; i++) {
          rt.propGroups[i].rotation.x += spin * dt * (rt.propDirs ? rt.propDirs[i] : 1);
        }
      },
      updateCamera(dt) {
        const rt = SIM.runtime;
        const rp = rt.replay;
        const drone = rt.drone;
        const pos = drone.position;
        _e1.setFromQuaternion(drone.quaternion, 'YXZ');
        const mode = rp.camForce >= 0 ? rp.camForce : Math.floor(rp.camTime/3.2) % 4;
        if (mode === 0) {
          const a = rp.camTime * 0.72;
          _v1.set(pos.x + Math.cos(a)*8, pos.y+3, pos.z + Math.sin(a)*8);
        } else if (mode === 1) {
          _e2.set(0, _e1.y, 0, 'YXZ');
          _v1.set(0, 1.5, 8).applyEuler(_e2).add(pos);
        } else if (mode === 2) {
          _e2.set(0, _e1.y, 0, 'YXZ');
          _v1.set(4, 2, -4).applyEuler(_e2).add(pos);
        } else {
          _e2.set(0, _e1.y, 0, 'YXZ');
          _v1.set(-3, 1.5, -6).applyEuler(_e2).add(pos);
        }
        const groundH = SIM.world.heightAt(_v1.x, _v1.z) + 0.6;
        if (_v1.y < groundH) _v1.y = groundH;
        const k = 1 - Math.exp(-dt*3.5);
        rt.chaseCamera.position.lerp(_v1, k);
        rt.chaseCamera.lookAt(pos.x, pos.y+0.2, pos.z);
        rt.activeCamera = rt.chaseCamera;
      },
      update(dt) {
        const rt = SIM.runtime;
        const rp = rt.replay;
        if (!rp.active) return;
        rp.playhead += dt*60*rp.speed;
        rp.camTime += dt;
        if (rp.playhead >= rp.total - 1) { this.stop(true); return; }
        this.applyFrame(rp.playhead);
        this.updateProps(dt);
        this.updateCamera(dt);
      }
    };
  })();

  // ===== ФИЗИКА САМОЛЁТА =====
  SIM.physics = (function () {
    const _v1 = new THREE.Vector3();
    const _v2 = new THREE.Vector3();
    const _v3 = new THREE.Vector3();
    const _q1 = new THREE.Quaternion();
    const _q2 = new THREE.Quaternion();
    const _e = new THREE.Euler();
    const _forward = new THREE.Vector3();
    const _up = new THREE.Vector3(0, 1, 0);
    const _right = new THREE.Vector3();
    const _targetAng = new THREE.Vector3();

    function expo(x) { return x * (0.55 + 0.45 * x * x); }

    function doCrash(reason) {
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
      _q1.set(st.angVel.x*half, st.angVel.y*half, st.angVel.z*half, 0);
      _q2.copy(st.quat).multiply(_q1);
      st.quat.x += _q2.x; st.quat.y += _q2.y;
      st.quat.z += _q2.z; st.quat.w += _q2.w;
      st.quat.normalize();
    }

    function updateWaypoints() {
      const st = SIM.state;
      const cfg = SIM.CONFIG;
      if (!SIM.runtime.started || st.crashed || !st.armed) return;
      const wp = SIM.waypoints[st.nextWaypoint];
      if (!wp) return;
      const d = st.pos.distanceTo(wp.pos);
      if (d < cfg.gateRadius) {
        st.nextWaypoint++;
        if (SIM.audio && SIM.audio.gateBeep) SIM.audio.gateBeep();
        if (st.nextWaypoint >= SIM.waypoints.length) {
          st.nextWaypoint = 0;
          st.range++;
          const missionTime = st.time - st.missionStartTime;
          st.lastRange = missionTime;
          st.missionStartTime = st.time;
          if (st.bestRange <= 0 || missionTime < st.bestRange) {
            st.bestRange = missionTime;
            try { localStorage.setItem('fpv1_ultra_best', String(st.bestRange)); } catch (e) {}
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
        if (rt.started && !st.crashed) st.time += dt;

        if (!st.crashed) {
          // Газ
          if (st.armed && st.fuel > 0) {
            if (keys.KeyW) st.throttle += dt * 0.85;
            if (keys.KeyS) st.throttle -= dt * 1.1;
            st.throttle = u.clamp(st.throttle, 0, 1);
          } else {
            st.throttle = Math.max(0, st.throttle - dt * 1.5);
          }

          // Spool
          const spoolK = 1 - Math.exp(-dt * 5.0);
          st.motor += (st.throttle - st.motor) * spoolK;
          st.motor = u.clamp(st.motor, 0, 1);

          // Управление рулями
          if (st.armed) {
            const pitchIn = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
            const yawIn = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
            const rollIn = (keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0);

            // Автокоординация: при крене добавляем немного rudder'а
            const coordinatedYaw = yawIn + rollIn * cfg.autoCoordination;

            _targetAng.set(
              expo(pitchIn) * cfg.pitchRate,
              expo(coordinatedYaw) * cfg.yawRate,
              expo(rollIn) * cfg.rollRate
            );
          } else {
            _targetAng.set(0, 0, 0);
          }

          const angK = 1 - Math.exp(-dt * cfg.response);
          st.angVel.lerp(_targetAng, angK);

          // Микро-турбулентность
          const turb = st.armed ? 0.05 : 0.008;
          st.angVel.x += (Math.random() - 0.5) * turb * dt * 10;
          st.angVel.y += (Math.random() - 0.5) * turb * dt * 10;
          st.angVel.z += (Math.random() - 0.5) * turb * dt * 10;

          integrateQuaternion(dt);

          // Направления БПЛА в мировых координатах
          _forward.set(1, 0, 0).applyQuaternion(st.quat);  // нос вперёд
          _right.set(0, 0, 1).applyQuaternion(st.quat);    // правое крыло
          const upDir = _v3.set(0, 1, 0).applyQuaternion(st.quat);

          // Скорость относительно воздуха
          st.wind.set(
            Math.sin(t*0.33)*2.6 + Math.sin(t*1.6)*0.8,
            Math.sin(t*0.8)*0.25,
            Math.cos(t*0.26)*2.8 + Math.cos(t*1.2)*0.7
          );
          _v1.copy(st.vel).sub(st.wind);  // airspeed vector
          const airSpeed = _v1.length();

          // Угол атаки: между вектором скорости и продольной осью БПЛА
          const forwardDot = _forward.dot(_v1.clone().normalize());
          const aoa = Math.acos(u.clamp(forwardDot, -1, 1));

          // Stall detection
          const isStalling = airSpeed < cfg.stallSpeed && !st.onGround;
          const isHighAoA = Math.abs(aoa) > cfg.stallAoA && !st.onGround;
          rt.stallWarning = isStalling || isHighAoA;
          if (rt.stallWarning) rt.stallFlash = 1;

          // Тяга (толкающий пропеллер вдоль forward)
          const thrustMag = st.motor * st.motor * cfg.maxThrust;
          _v2.copy(_forward).multiplyScalar(thrustMag);

          // Подъёмная сила (перпендикулярно скорости, направлена "вверх" по upDir)
          // lift = 0.5 * v² * Cl * S, упрощённо: v² * liftCoeff
          let liftMag = airSpeed * airSpeed * cfg.liftCoeff;

          // Stall reduces lift
          if (isHighAoA) liftMag *= Math.max(0, 1 - (Math.abs(aoa) - cfg.stallAoA) * 2);
          if (isStalling) liftMag *= Math.max(0, airSpeed / cfg.stallSpeed);

          // Lift direction: component of upDir perpendicular to velocity
          const liftDir = upDir.clone();
          if (airSpeed > 0.1) {
            const velNorm = _v1.clone().normalize();
            liftDir.sub(velNorm.clone().multiplyScalar(velNorm.dot(upDir)));
            if (liftDir.lengthSq() < 0.0001) liftDir.copy(_up);
            else liftDir.normalize();
          } else {
            liftDir.copy(_up);
          }
          _v2.addScaledVector(liftDir, liftMag);

          // Сопротивление (против вектора скорости)
          const dragMag = airSpeed * airSpeed * (cfg.dragCoeff + cfg.inducedDrag * liftMag / Math.max(1, airSpeed*airSpeed));
          if (airSpeed > 0.01) {
            _v2.addScaledVector(_v1.clone().normalize(), -dragMag);
          }

          // Гравитация
          _v2.y -= cfg.gravity;

          // Земное трение (пока на земле до взлёта)
          const groundH = SIM.world.heightAt(st.pos.x, st.pos.z);
          const groundY = groundH + cfg.gearOffset;
          if (st.pos.y <= groundY + 0.05 && st.vel.y <= 0.1) {
            st.onGround = true;
            // Трение тормозит движение по XZ
            const hVel = new THREE.Vector3(st.vel.x, 0, st.vel.z);
            _v2.addScaledVector(hVel, -cfg.groundFriction);

            // На земле автовыравнивание по pitch (нос чуть вверх) и обнуление roll
            const targetQuat = new THREE.Quaternion();
            const targetEuler = new THREE.Euler(0, _e.setFromQuaternion(st.quat, 'YXZ').y, 0, 'YXZ');
            targetQuat.setFromEuler(targetEuler);
            st.quat.slerp(targetQuat, 1 - Math.exp(-dt * 3));
          } else {
            st.onGround = false;
          }

          st.vel.addScaledVector(_v2, dt);
          st.pos.addScaledVector(st.vel, dt);

          // Границы мира
          if (Math.abs(st.pos.x) > cfg.worldBound) { st.pos.x = u.clamp(st.pos.x, -cfg.worldBound, cfg.worldBound); st.vel.x *= -0.3; }
          if (Math.abs(st.pos.z) > cfg.worldBound) { st.pos.z = u.clamp(st.pos.z, -cfg.worldBound, cfg.worldBound); st.vel.z *= -0.3; }
          if (st.pos.y > cfg.altitudeLimit) { st.pos.y = cfg.altitudeLimit; st.vel.y *= -0.1; }

          // Столкновение с землёй
          if (st.pos.y <= groundY) {
            const hSpeed = Math.sqrt(st.vel.x*st.vel.x + st.vel.z*st.vel.z);
            const vertSpeed = st.vel.y;

            // Детонация: удар на скорости, слишком крутой угол, или низкая скорость при большой вертикальной
            const hardImpact = vertSpeed < -cfg.crashSpeed;
            const noseDown = _forward.y < -0.7;
            const steepAngle = Math.abs(_e.setFromQuaternion(st.quat, 'YXZ').x) > cfg.crashAoA;
            const fastLanding = hSpeed > 20 && Math.abs(vertSpeed) > 4;

            if (hardImpact || noseDown || steepAngle || fastLanding) {
              doCrash('impact');
            } else {
              st.pos.y = groundY;
              if (st.vel.y < 0) st.vel.y = 0;
              st.vel.x *= 0.96;
              st.vel.z *= 0.96;
            }
          }

          // Топливо
          if (st.armed && st.fuel > 0) {
            const burn = cfg.fuelBurnRate * (0.3 + st.motor * 0.7);
            st.fuel = u.clamp(st.fuel - burn * dt, 0, 100);
          }
          if (st.fuel <= 0 && st.armed) st.armed = false;
        } else {
          // После краша: инерция + гравитация
          st.vel.y -= cfg.gravity * dt;
          st.pos.addScaledVector(st.vel, dt);
          const groundH = SIM.world.heightAt(st.pos.x, st.pos.z) + 0.1;
          if (st.pos.y < groundH) { st.pos.y = groundH; st.vel.set(0, 0, 0); }
          st.motor = Math.max(0, st.motor - dt * 4);
        }

        if (!isFinite(st.pos.x+st.pos.y+st.pos.z+st.vel.x+st.vel.y+st.vel.z+st.quat.x+st.quat.y+st.quat.z+st.quat.w)) {
          if (SIM.main && SIM.main.reset) SIM.main.reset();
        }

        st.distance = Math.sqrt(st.pos.x*st.pos.x + st.pos.z*st.pos.z);
        st.rssi = u.clamp(104 - st.distance*0.052 - (st.crashed ? 42 : 0) - Math.random()*4, 3, 100);
        st.link = u.clamp(st.rssi - Math.random()*7, 1, 100);
        st.gps = st.crashed ? 0 : u.clamp(Math.floor(7 + st.rssi/10), 4, 14);

        updateWaypoints();
      }
    };
  })();

  // ===== MAIN =====
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
        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      } catch (err) { showFatal('WebGL недоступен.'); return; }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;

      u.dom('app').appendChild(renderer.domElement);
      renderer.domElement.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        showFatal('WebGL-контекст потерян.');
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

      this.loadBestRange();
      this.bindButtons();
      this.reset();

      window.addEventListener('resize', this.onResize.bind(this));
      requestAnimationFrame(this.loop.bind(this));
    },

    bindButtons() {
      this.ui.startBtn.addEventListener('click', () => { this.ui.startBtn.blur(); this.start(); });
      this.ui.respawnBtn.addEventListener('click', () => { this.ui.respawnBtn.blur(); this.reset(); });
      this.ui.watchReplayBtn.addEventListener('click', () => { this.ui.watchReplayBtn.blur(); this.watchReplay(); });
      this.ui.helpClose.addEventListener('click', () => { this.ui.helpClose.blur(); this.toggleHelp(); });
      this.ui.closeMapBtn.addEventListener('click', () => { this.ui.closeMapBtn.blur(); this.toggleMap(); });
    },

    loadBestRange() {
      try {
        const v = parseFloat(localStorage.getItem('fpv1_ultra_best'));
        if (isFinite(v) && v > 0) SIM.state.bestRange = v;
      } catch (e) {}
    },

    start() {
      const rt = SIM.runtime;
      if (rt.started) return;
      rt.started = true;
      this.ui.startOverlay.style.display = 'none';
      if (SIM.audio && SIM.audio.init) SIM.audio.init();
      if (SIM.audio && SIM.audio.ctx && SIM.audio.ctx.state === 'suspended') SIM.audio.ctx.resume();
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
      st.onGround = true;

      st.throttle = 0;
      st.motor = 0;
      st.fuel = 100;
      st.voltage = 16.8;
      st.current = 0;

      st.time = 0;
      st.missionStartTime = 0;
      st.range = 1;
      st.nextWaypoint = 0;
      st.lastRange = 0;

      st.rssi = 100; st.link = 100; st.gps = 12; st.distance = 0;

      const groundH = SIM.world ? SIM.world.heightAt(0, 80) : 0;
      st.pos.set(0, groundH + cfg.gearOffset + 0.05, 80);  // на ВПП
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

    showCrash() { this.ui.crashOverlay.style.display = 'flex'; },

    watchReplay() {
      const rt = SIM.runtime;
      if (rt.replay.active) return;
      if (!SIM.replay.start(false)) if (SIM.audio && SIM.audio.uiBeep) SIM.audio.uiBeep();
    },

    toggleArm() {
      const st = SIM.state;
      const rt = SIM.runtime;
      if (!rt.started || st.crashed) return;
      if (!st.armed && st.fuel <= 0) return;

      st.armed = !st.armed;
      if (st.armed) {
        st.throttle = 0.3;  // автоматом небольшой газ для быстрого старта
        st.motor = 0;
        rt.recorder.frames.length = 0;
        if (SIM.audio && SIM.audio.ctx && SIM.audio.ctx.state === 'suspended') SIM.audio.ctx.resume();
      }
      if (SIM.audio && SIM.audio.uiBeep) SIM.audio.uiBeep();
    },

    toggleView() {
      SIM.runtime.viewMode = SIM.runtime.viewMode === 'fpv' ? 'chase' : 'fpv';
      if (SIM.audio && SIM.audio.uiBeep) SIM.audio.uiBeep();
    },

    toggleHelp() {
      SIM.runtime.helpVisible = !SIM.runtime.helpVisible;
      this.ui.helpOverlay.style.display = SIM.runtime.helpVisible ? 'flex' : 'none';
    },

    toggleMap() {
      SIM.runtime.mapVisible = !SIM.runtime.mapVisible;
      this.ui.fullMapOverlay.style.display = SIM.runtime.mapVisible ? 'flex' : 'none';
      if (SIM.runtime.mapVisible) SIM.minimap.drawFull();
    },

    onResize() {
      const rt = SIM.runtime;
      const w = window.innerWidth, h = window.innerHeight;
      rt.renderer.setSize(w, h);
      if (rt.fpvCamera) { rt.fpvCamera.aspect = w/h; rt.fpvCamera.updateProjectionMatrix(); }
      if (rt.chaseCamera) { rt.chaseCamera.aspect = w/h; rt.chaseCamera.updateProjectionMatrix(); }
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
            ctx.fillStyle = 'rgba(255,255,255,' + (Math.random()*0.22).toFixed(3) + ')';
            ctx.fillRect(Math.random()*canvas.width, Math.random()*canvas.height, 1+Math.random()*2, 1+Math.random()*2);
          }
          if (Math.random() < 0.18) {
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fillRect(0, Math.random()*canvas.height, canvas.width, 1+Math.random()*3);
          }
        }
      }

      let op = SIM.utils.clamp((94 - st.rssi) / 75, 0, 0.82);
      if (st.crashed) op = Math.min(0.95, op + 0.2);
      canvas.style.opacity = op.toFixed(3);
    },

    updateSun() {
      const rt = SIM.runtime;
      if (!rt.sun || !rt.sunTarget) return;
      rt.sun.position.copy(SIM.state.pos).add(this._sunOffset);
      rt.sunTarget.position.copy(SIM.state.pos);
    },

    updateFPS(now) {
      const rt = SIM.runtime;
      rt.fpsFrames++;
      if (now - rt.fpsTime >= 500) {
        rt.fps = rt.fpsFrames*1000 / (now - rt.fpsTime);
        rt.fpsTime = now; rt.fpsFrames = 0;
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

      // Stall flash decay
      if (rt.stallFlash > 0) rt.stallFlash = Math.max(0, rt.stallFlash - dt * 3);

      if (rt.replay.active) {
        SIM.replay.update(dt);
        SIM.hud.update();
        if (SIM.audio && SIM.audio.update) SIM.audio.update();
        rt.renderer.render(rt.scene, rt.activeCamera);
        return;
      }

      if (rt.started && !st.crashed) SIM.replay.record();

      SIM.physics.update(dt, rt.simTime);

      if (st.crashed && rt.started && !rt.replay.active) {
        SIM.replay.record();
        if (!SIM.replay.start(true)) this.showCrash();
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
      if (rt.mapVisible) SIM.minimap.drawFull();
      if (SIM.audio && SIM.audio.update) SIM.audio.update();
      rt.renderer.render(rt.scene, rt.activeCamera);
    }
  };

  SIM.main.init();
})();
