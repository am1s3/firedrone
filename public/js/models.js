(function () {
  'use strict';

  if (typeof THREE === 'undefined') return;
  if (!window.SIM || !SIM.runtime || !SIM.runtime.scene) return;

  const rt = SIM.runtime;
  const scene = rt.scene;

  const status = {
    drone: 'PROC',
    city: 'PROC'
  };

  function renderChip() {
    const chip = document.getElementById('models');
    if (chip) {
      chip.textContent = 'FPV-1: ' + status.drone + ' · CITY: ' + status.city;
    }
  }

  if (!THREE.GLTFLoader) {
    renderChip();
    return;
  }

  const DRONE_URLS = [
    'https://cdn.jsdelivr.net/gh/srcejon/sdrangel-3d-models@main/drone.glb',
    'https://raw.githubusercontent.com/srcejon/sdrangel-3d-models/main/drone.glb'
  ];

  const CITY_URLS = [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@dev/examples/models/gltf/LittlestTokyo.glb',
    'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/LittlestTokyo.glb'
  ];

  const loader = new THREE.GLTFLoader();

  function loadGLB(urls, timeoutMs) {
    return new Promise((resolve, reject) => {
      let idx = 0;
      let done = false;

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('timeout'));
        }
      }, timeoutMs);

      function tryNext() {
        if (done) return;

        if (idx >= urls.length) {
          done = true;
          clearTimeout(timer);
          reject(new Error('all sources failed'));
          return;
        }

        const url = urls[idx++];

        loader.load(
          url,
          (gltf) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(gltf);
          },
          undefined,
          () => tryNext()
        );
      }

      tryNext();
    });
  }

  function installDrone(gltf) {
    const skin = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!skin || !rt.drone) return false;

    const box = new THREE.Box3().setFromObject(skin);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = 0.72 / maxDim;

    skin.scale.setScalar(s);
    skin.position.set(-center.x * s, -center.y * s, -center.z * s);

    skin.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;

        if (o.material && o.material.isMeshStandardMaterial) {
          o.material.envMapIntensity = 0.7;
        }
      }
    });

    rt.drone.add(skin);

    rt.drone.children.forEach((c) => {
      if (c !== skin && c !== rt.fpvCamera) {
        c.visible = false;
      }
    });

    const props = [];
    skin.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (/prop|rotor|blade|spin|motor/.test(n)) {
        props.push(o);
      }
    });

    if (props.length >= 2) {
      rt.propGroups = props.slice(0, 4);
    }

    return true;
  }

  function normalizeCity(root, targetSize) {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const holder = new THREE.Group();
    holder.add(root);
    root.position.set(-center.x, -box.min.y, -center.z);

    const s = targetSize / Math.max(size.x, size.z, 1);
    holder.scale.setScalar(s);

    return holder;
  }

  function installCity(gltf) {
    const city = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!city) return false;

    const toRemove = [];
    scene.traverse((o) => {
      if (o.isMesh && Array.isArray(o.material) && o.material.length === 6) {
        toRemove.push(o);
      }
    });

    toRemove.forEach((o) => {
      if (o.parent) o.parent.remove(o);
    });

    city.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = true;
      }
    });

    const cityRoot = normalizeCity(city, 300);

    const spots = [
      { x: -340, z: -340, ry: 0.6, s: 1.15 },
      { x: 430, z: -250, ry: -1.25, s: 1.0 },
      { x: -150, z: 440, ry: 2.2, s: 0.9 }
    ];

    spots.forEach((sp, i) => {
      const inst = i === 0 ? cityRoot : cityRoot.clone(true);
      const h = SIM.world.heightAt(sp.x, sp.z);

      inst.position.set(sp.x, h - 2.5, sp.z);
      inst.rotation.y = sp.ry;
      inst.scale.multiplyScalar(sp.s);

      scene.add(inst);
    });

    return true;
  }

  status.drone = 'LOAD';
  status.city = 'LOAD';
  renderChip();

  loadGLB(DRONE_URLS, 12000)
    .then((gltf) => {
      status.drone = installDrone(gltf) ? 'GLB' : 'PROC';
      renderChip();
    })
    .catch(() => {
      status.drone = 'PROC';
      renderChip();
    });

  loadGLB(CITY_URLS, 25000)
    .then((gltf) => {
      status.city = installCity(gltf) ? 'GLB' : 'PROC';
      renderChip();
    })
    .catch(() => {
      status.city = 'PROC';
      renderChip();
    });
})();
