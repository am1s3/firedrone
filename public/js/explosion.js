(function () {
  'use strict';

  if (typeof THREE === 'undefined') return;
  if (!window.SIM || !SIM.runtime || !SIM.main || !SIM.state || !SIM.world) return;

  const SIM = window.SIM;
  const u = SIM.utils;
  const rt = SIM.runtime;
  const scene = rt.scene;

  if (!scene) return;

  const particleTexture = makeRadialTexture();
  const smokeTexture = makeSmokeTexture();

  let explosion = null;
  let pendingCrashCenter = null;
  let lastCrashCenter = null;
  let wasCrashed = SIM.state.crashed;
  let cssShake = 0;
  let lastSoundTime = 0;
  let lastTime = performance.now();

  const flashEl = u.dom('explosionFlash');

  const originalReset = SIM.main.reset.bind(SIM.main);
  SIM.main.reset = function () {
    clearExplosion();
    pendingCrashCenter = null;
    wasCrashed = false;
    originalReset();
  };

  if (typeof SIM.main.watchReplay === 'function') {
    const originalWatchReplay = SIM.main.watchReplay.bind(SIM.main);
    SIM.main.watchReplay = function () {
      if (SIM.state.crashed && lastCrashCenter) {
        clearExplosion();
        pendingCrashCenter = lastCrashCenter.clone();
      }
      originalWatchReplay();
    };
  }

  function makeRadialTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;

    const g = c.getContext('2d');
    const gradient = g.createRadialGradient(32, 32, 1, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');

    g.fillStyle = gradient;
    g.fillRect(0, 0, 64, 64);

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  function makeSmokeTexture() {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;

    const g = c.getContext('2d');

    g.clearRect(0, 0, 128, 128);

    for (let i = 0; i < 16; i++) {
      const x = 30 + Math.random() * 68;
      const y = 30 + Math.random() * 68;
      const r = 14 + Math.random() * 28;

      const gradient = g.createRadialGradient(x, y, 1, x, y, r);
      gradient.addColorStop(0, 'rgba(255,255,255,0.14)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');

      g.fillStyle = gradient;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  function makeParticleSystem(count, size, blending, useVertexColors) {
    const geometry = new THREE.BufferGeometry();

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = 0;
      positions[i * 3 + 1] = -9999;
      positions[i * 3 + 2] = 0;

      colors[i * 3 + 0] = 0;
      colors[i * 3 + 1] = 0;
      colors[i * 3 + 2] = 0;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size,
      map: particleTexture,
      transparent: true,
      depthWrite: false,
      blending,
      vertexColors: useVertexColors,
      sizeAttenuation: true
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    return {
      points,
      velocities: new Float32Array(count * 3),
      life: new Float32Array(count),
      maxLife: new Float32Array(count)
    };
  }

  function randomDirection(target) {
    target.set(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1
    );

    if (target.lengthSq() < 0.001) {
      target.set(0, 1, 0);
    }

    target.normalize();
    return target;
  }

  function createExplosion(center) {
    clearExplosion();

    const groundH = SIM.world.heightAt(center.x, center.z);
    const explosionCenter = center.clone();

    if (explosionCenter.y < groundH + 0.12) {
      explosionCenter.y = groundH + 0.12;
    }

    const groundLocal = groundH - explosionCenter.y;

    const group = new THREE.Group();
    group.position.copy(explosionCenter);
    scene.add(group);

    const light = new THREE.PointLight(0xff8a2a, 22, 90, 2);
    light.position.set(0, 1.1, 0);
    group.add(light);

    const shockMaterial = new THREE.MeshBasicMaterial({
      color: 0xffbb66,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    const shock = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 20),
      shockMaterial
    );
    group.add(shock);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd7a0,
      transparent: true,
      opacity: 0.48,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.15, 48),
      ringMaterial
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = groundLocal + 0.05;
    group.add(ring);

    const scorchMaterial = new THREE.MeshBasicMaterial({
      color: 0x050505,
      transparent: true,
      opacity: 0.72,
      depthWrite: false
    });

    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(3.1, 28),
      scorchMaterial
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = groundLocal + 0.03;
    group.add(scorch);

    const fire = makeParticleSystem(190, 1.85, THREE.AdditiveBlending, true);
    const sparks = makeParticleSystem(260, 0.18, THREE.AdditiveBlending, true);

    group.add(fire.points);
    group.add(sparks.points);

    initFire(fire);
    initSparks(sparks);

    const smoke = createSmoke(group);
    const debris = createDebris(group, groundLocal);

    explosion = {
      age: 0,
      center: explosionCenter.clone(),
      groundLocal,
      group,
      light,
      shock,
      shockMaterial,
      ring,
      ringMaterial,
      scorch,
      scorchMaterial,
      fire,
      sparks,
      smoke,
      debris
    };

    cssShake = 1.55;
    setFlash(0.92);
  }

  function initFire(fire) {
    const pos = fire.points.geometry.attributes.position.array;
    const col = fire.points.geometry.attributes.color.array;
    const dir = new THREE.Vector3();

    for (let i = 0; i < fire.life.length; i++) {
      const i3 = i * 3;

      randomDirection(dir);

      pos[i3 + 0] = dir.x * 0.2;
      pos[i3 + 1] = dir.y * 0.18 + 0.15;
      pos[i3 + 2] = dir.z * 0.2;

      const speed = 2.5 + Math.random() * 11.5;

      fire.velocities[i3 + 0] = dir.x * speed;
      fire.velocities[i3 + 1] = Math.abs(dir.y) * speed * 0.65 + 1.8 + Math.random() * 5.2;
      fire.velocities[i3 + 2] = dir.z * speed;

      fire.maxLife[i] = 0.38 + Math.random() * 0.78;
      fire.life[i] = fire.maxLife[i];

      col[i3 + 0] = 1;
      col[i3 + 1] = 0.85;
      col[i3 + 2] = 0.4;
    }

    fire.points.geometry.attributes.position.needsUpdate = true;
    fire.points.geometry.attributes.color.needsUpdate = true;
  }

  function initSparks(sparks) {
    const pos = sparks.points.geometry.attributes.position.array;
    const col = sparks.points.geometry.attributes.color.array;
    const dir = new THREE.Vector3();

    for (let i = 0; i < sparks.life.length; i++) {
      const i3 = i * 3;

      randomDirection(dir);

      pos[i3 + 0] = dir.x * 0.12;
      pos[i3 + 1] = dir.y * 0.12 + 0.12;
      pos[i3 + 2] = dir.z * 0.12;

      const speed = 9 + Math.random() * 32;

      sparks.velocities[i3 + 0] = dir.x * speed;
      sparks.velocities[i3 + 1] = Math.abs(dir.y) * speed * 0.55 + 2.5 + Math.random() * 8.5;
      sparks.velocities[i3 + 2] = dir.z * speed;

      sparks.maxLife[i] = 0.8 + Math.random() * 1.55;
      sparks.life[i] = sparks.maxLife[i];

      col[i3 + 0] = 1;
      col[i3 + 1] = 0.88;
      col[i3 + 2] = 0.55;
    }

    sparks.points.geometry.attributes.position.needsUpdate = true;
    sparks.points.geometry.attributes.color.needsUpdate = true;
  }

  function createSmoke(group) {
    const items = [];

    for (let i = 0; i < 44; i++) {
      const material = new THREE.SpriteMaterial({
        map: smokeTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        color: new THREE.Color(0x666666)
      });

      const sprite = new THREE.Sprite(material);

      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.8;

      sprite.position.set(
        Math.cos(a) * r,
        0.2 + Math.random() * 0.8,
        Math.sin(a) * r
      );

      const s = 1.2 + Math.random() * 2.6;
      sprite.scale.set(s, s, 1);

      material.rotation = Math.random() * Math.PI * 2;

      group.add(sprite);

      items.push({
        sprite,
        material,
        velocity: new THREE.Vector3(
          Math.cos(a) * (0.8 + Math.random() * 3.2),
          1.2 + Math.random() * 3.6,
          Math.sin(a) * (0.8 + Math.random() * 3.2)
        ),
        life: 0,
        delay: Math.random() * 0.22,
        maxLife: 2.2 + Math.random() * 3.2,
        growth: 1.8 + Math.random() * 3.2,
        baseOpacity: 0.16 + Math.random() * 0.22
      });
    }

    return items;
  }

  function createDebris(group, groundLocal) {
    const items = [];
    const geoms = [];
    const mats = [];

    const materialPalette = [
      new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.42, metalness: 0.65 }),
      new THREE.MeshStandardMaterial({ color: 0xff2d55, roughness: 0.32, metalness: 0.42 }),
      new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.2, metalness: 0.92 }),
      new THREE.MeshStandardMaterial({ color: 0x0d5e2d, roughness: 0.42, metalness: 0.2 }),
      new THREE.MeshStandardMaterial({ color: 0x20242a, roughness: 0.55, metalness: 0.35 })
    ];

    mats.push(...materialPalette);

    for (let i = 0; i < 34; i++) {
      const type = Math.floor(Math.random() * 4);
      let geometry;

      if (type === 0) {
        geometry = new THREE.BoxGeometry(
          0.03 + Math.random() * 0.13,
          0.02 + Math.random() * 0.08,
          0.03 + Math.random() * 0.16
        );
      } else if (type === 1) {
        geometry = new THREE.CylinderGeometry(
          0.012 + Math.random() * 0.028,
          0.016 + Math.random() * 0.035,
          0.04 + Math.random() * 0.12,
          7
        );
      } else if (type === 2) {
        geometry = new THREE.TetrahedronGeometry(0.03 + Math.random() * 0.075);
      } else {
        geometry = new THREE.BoxGeometry(
          0.01 + Math.random() * 0.04,
          0.005 + Math.random() * 0.01,
          0.08 + Math.random() * 0.22
        );
      }

      geoms.push(geometry);

      const material = materialPalette[Math.floor(Math.random() * materialPalette.length)];
      const mesh = new THREE.Mesh(geometry, material);

      mesh.castShadow = true;

      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 1.4 - 0.35,
        Math.random() * 2 - 1
      ).normalize();

      mesh.position.copy(dir).multiplyScalar(0.12 + Math.random() * 0.35);
      mesh.position.y = Math.max(mesh.position.y, 0.06);

      mesh.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      );

      group.add(mesh);

      const speed = 3.5 + Math.random() * 18;

      items.push({
        mesh,
        velocity: new THREE.Vector3(
          dir.x * speed,
          Math.abs(dir.y) * speed * 0.55 + 1.5 + Math.random() * 7.5,
          dir.z * speed
        ),
        angularVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 16
        ),
        size: Math.max(geometry.boundingBox ? 0.05 : 0.05, 0.045),
        sleeping: false
      });
    }

    explosionGeometries = geoms;
    explosionMaterials = mats;

    return items;
  }

  let explosionGeometries = [];
  let explosionMaterials = [];

  function clearExplosion() {
    if (!explosion) {
      setFlash(0);
      cssShake = 0;
      resetCanvasTransform();
      return;
    }

    scene.remove(explosion.group);

    explosion.group.traverse((obj) => {
      if (obj.geometry) {
        obj.geometry.dispose();
      }

      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          m.dispose();
        });
      }
    });

    explosionGeometries.forEach((g) => g.dispose());
    explosionMaterials.forEach((m) => m.dispose());

    explosionGeometries = [];
    explosionMaterials = [];

    explosion = null;
    setFlash(0);
    cssShake = 0;
    resetCanvasTransform();
  }

  function setFlash(value) {
    if (flashEl) {
      flashEl.style.opacity = String(Math.max(0, Math.min(1, value)));
    }
  }

  function resetCanvasTransform() {
    if (rt.renderer && rt.renderer.domElement) {
      rt.renderer.domElement.style.transform = '';
    }
  }

  function applyCssShake(dt) {
    if (!rt.renderer || !rt.renderer.domElement) return;

    cssShake = Math.max(0, cssShake - dt * 2.15);

    if (cssShake <= 0.001) {
      resetCanvasTransform();
      return;
    }

    const magnitude = cssShake * 10;
    const x = (Math.random() - 0.5) * magnitude;
    const y = (Math.random() - 0.5) * magnitude;
    const scale = 1 + cssShake * 0.006;

    rt.renderer.domElement.style.transform =
      'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px) scale(' + scale.toFixed(4) + ')';
  }

  function updateFire(dt) {
    if (!explosion) return;

    const fire = explosion.fire;
    const posAttr = fire.points.geometry.attributes.position;
    const colAttr = fire.points.geometry.attributes.color;

    const pos = posAttr.array;
    const col = colAttr.array;

    for (let i = 0; i < fire.life.length; i++) {
      const i3 = i * 3;

      if (fire.life[i] <= 0) {
        pos[i3 + 1] = -9999;
        col[i3 + 0] = 0;
        col[i3 + 1] = 0;
        col[i3 + 2] = 0;
        continue;
      }

      fire.life[i] -= dt;

      if (fire.life[i] <= 0) {
        pos[i3 + 1] = -9999;
        col[i3 + 0] = 0;
        col[i3 + 1] = 0;
        col[i3 + 2] = 0;
        continue;
      }

      const drag = Math.exp(-2.7 * dt);

      fire.velocities[i3 + 0] *= drag;
      fire.velocities[i3 + 1] = fire.velocities[i3 + 1] * drag + 3.1 * dt;
      fire.velocities[i3 + 2] *= drag;

      pos[i3 + 0] += fire.velocities[i3 + 0] * dt;
      pos[i3 + 1] += fire.velocities[i3 + 1] * dt;
      pos[i3 + 2] += fire.velocities[i3 + 2] * dt;

      const t = fire.life[i] / fire.maxLife[i];

      let r = 1;
      let g = 0.12;
      let b = 0.02;

      if (t > 0.76) {
        r = 1;
        g = 0.92;
        b = 0.46;
      } else if (t > 0.46) {
        r = 1;
        g = 0.44;
        b = 0.07;
      } else {
        r = 0.52;
        g = 0.09;
        b = 0.02;
      }

      const fade = Math.pow(t, 1.15);

      col[i3 + 0] = r * fade;
      col[i3 + 1] = g * fade;
      col[i3 + 2] = b * fade;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  function updateSparks(dt) {
    if (!explosion) return;

    const sparks = explosion.sparks;
    const posAttr = sparks.points.geometry.attributes.position;
    const colAttr = sparks.points.geometry.attributes.color;

    const pos = posAttr.array;
    const col = colAttr.array;

    for (let i = 0; i < sparks.life.length; i++) {
      const i3 = i * 3;

      if (sparks.life[i] <= 0) {
        pos[i3 + 1] = -9999;
        col[i3 + 0] = 0;
        col[i3 + 1] = 0;
        col[i3 + 2] = 0;
        continue;
      }

      sparks.life[i] -= dt;

      if (sparks.life[i] <= 0) {
        pos[i3 + 1] = -9999;
        col[i3 + 0] = 0;
        col[i3 + 1] = 0;
        col[i3 + 2] = 0;
        continue;
      }

      const drag = Math.exp(-0.22 * dt);

      sparks.velocities[i3 + 0] *= drag;
      sparks.velocities[i3 + 1] = sparks.velocities[i3 + 1] * drag - 14.5 * dt;
      sparks.velocities[i3 + 2] *= drag;

      pos[i3 + 0] += sparks.velocities[i3 + 0] * dt;
      pos[i3 + 1] += sparks.velocities[i3 + 1] * dt;
      pos[i3 + 2] += sparks.velocities[i3 + 2] * dt;

      const localGround = explosion.groundLocal + 0.02;

      if (pos[i3 + 1] < localGround && sparks.velocities[i3 + 1] < 0) {
        pos[i3 + 1] = localGround;

        sparks.velocities[i3 + 1] *= -0.36;
        sparks.velocities[i3 + 0] *= 0.68;
        sparks.velocities[i3 + 2] *= 0.68;

        const vx = sparks.velocities[i3 + 0];
        const vy = sparks.velocities[i3 + 1];
        const vz = sparks.velocities[i3 + 2];
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);

        if (speed < 0.4) {
          sparks.life[i] = Math.min(sparks.life[i], 0.08);
        }
      }

      const t = sparks.life[i] / sparks.maxLife[i];
      const fade = Math.pow(t, 1.35);

      col[i3 + 0] = 1 * fade;
      col[i3 + 1] = 0.86 * fade;
      col[i3 + 2] = 0.48 * fade;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  function updateSmoke(dt) {
    if (!explosion) return;

    const wind = SIM.state.wind;

    for (let i = 0; i < explosion.smoke.length; i++) {
      const s = explosion.smoke[i];

      if (s.delay > 0) {
        s.delay -= dt;
        continue;
      }

      s.life += dt;

      if (s.life >= s.maxLife) {
        s.material.opacity = 0;
        continue;
      }

      const t = s.life / s.maxLife;

      s.velocity.multiplyScalar(Math.exp(-0.55 * dt));
      s.velocity.y += 0.45 * dt;
      s.velocity.x += wind.x * 0.012 * dt;
      s.velocity.z += wind.z * 0.012 * dt;

      s.sprite.position.addScaledVector(s.velocity, dt);

      const grow = s.growth * dt;
      s.sprite.scale.x += grow;
      s.sprite.scale.y += grow;

      s.material.rotation += dt * 0.12;

      const fadeIn = Math.min(1, s.life / 0.4);
      const fadeOut = 1 - t;

      s.material.opacity = s.baseOpacity * fadeIn * fadeOut;

      const darkness = 0.16 + t * 0.18;
      s.material.color.setRGB(darkness, darkness, darkness);
    }
  }

  function updateDebris(dt) {
    if (!explosion) return;

    const center = explosion.center;

    for (let i = 0; i < explosion.debris.length; i++) {
      const d = explosion.debris[i];

      if (d.sleeping) continue;

      d.velocity.y -= 9.81 * 1.06 * dt;
      d.velocity.multiplyScalar(Math.exp(-0.42 * dt));

      d.mesh.position.addScaledVector(d.velocity, dt);

      d.mesh.rotation.x += d.angularVelocity.x * dt;
      d.mesh.rotation.y += d.angularVelocity.y * dt;
      d.mesh.rotation.z += d.angularVelocity.z * dt;

      d.angularVelocity.multiplyScalar(Math.exp(-0.75 * dt));

      const worldX = center.x + d.mesh.position.x;
      const worldZ = center.z + d.mesh.position.z;
      const localGround = SIM.world.heightAt(worldX, worldZ) - center.y + d.size;

      if (d.mesh.position.y < localGround && d.velocity.y < 0) {
        d.mesh.position.y = localGround;

        d.velocity.y *= -0.28;
        d.velocity.x *= 0.74;
        d.velocity.z *= 0.74;

        d.angularVelocity.multiplyScalar(0.58);

        if (d.velocity.length() < 0.28 && Math.abs(d.velocity.y) < 0.22) {
          d.sleeping = true;
        }
      }
    }
  }

  function updateExplosion(dt) {
    if (!explosion) return;

    explosion.age += dt;
    const age = explosion.age;

    if (age < 0.2) {
      explosion.light.intensity = 24 + Math.random() * 12;
    } else if (age < 0.8) {
      explosion.light.intensity = Math.max(0, 18 * (1 - (age - 0.2) / 0.6)) + Math.random() * 2;
    } else {
      explosion.light.intensity = 0;
    }

    explosion.shock.scale.setScalar(1 + age * 58);
    explosion.shockMaterial.opacity = Math.max(0, 0.44 * (1 - age / 0.42));

    explosion.ring.scale.setScalar(1 + age * 38);
    explosion.ringMaterial.opacity = Math.max(0, 0.5 * (1 - age / 0.56));

    if (age < 12) {
      explosion.scorchMaterial.opacity = 0.72;
    } else if (age < 20) {
      explosion.scorchMaterial.opacity = Math.max(0, 0.72 * (1 - (age - 12) / 8));
    }

    setFlash(Math.max(0, 0.92 * (1 - age / 0.24)));

    updateFire(dt);
    updateSparks(dt);
    updateSmoke(dt);
    updateDebris(dt);

    if (age > 20) {
      clearExplosion();
    }
  }

  function shouldTriggerPendingExplosion() {
    if (!pendingCrashCenter) return false;
    if (explosion) return false;

    const rp = rt.replay;

    if (!rp || !rp.active) {
      return true;
    }

    return rp.playhead >= Math.max(0, rp.total - 4);
  }

  function loop(now) {
    requestAnimationFrame(loop);

    let dt = (now - lastTime) / 1000;
    lastTime = now;

    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) dt = 0.0001;

    const st = SIM.state;

    if (st.crashed && !wasCrashed) {
      const center = rt.drone ? rt.drone.position.clone() : st.pos.clone();
      pendingCrashCenter = center.clone();
      lastCrashCenter = center.clone();
      wasCrashed = true;
    }

    if (!st.crashed && wasCrashed) {
      wasCrashed = false;
      pendingCrashCenter = null;
      clearExplosion();
    }

    if (shouldTriggerPendingExplosion()) {
      createExplosion(pendingCrashCenter);
      pendingCrashCenter = null;
    }

    updateExplosion(dt);
    applyCssShake(dt);
  }

  requestAnimationFrame(loop);
})();
