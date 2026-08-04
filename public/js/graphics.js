(function () {
  'use strict';

  if (typeof THREE === 'undefined') return;
  if (!window.SIM || !SIM.runtime) return;

  const rt = SIM.runtime;
  const renderer = rt.renderer;
  const scene = rt.scene;

  if (!renderer || !scene) return;

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.26;
  renderer.outputEncoding = THREE.sRGBEncoding;

  if (rt.sun) {
    rt.sun.intensity = 1.45;
  }

  scene.traverse((o) => {
    if (o.isHemisphereLight) {
      o.intensity = 1.12;
    }
  });

  function boostMaterials() {
    scene.traverse((o) => {
      if (o.isMesh && o.material && o.material.isMeshStandardMaterial) {
        o.material.envMapIntensity = 0.55;
        o.material.needsUpdate = true;
      }
    });
  }

  function applyEquirect(tex) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envRT = pmrem.fromEquirectangular(tex);

      scene.environment = envRT.texture;

      tex.dispose();
      pmrem.dispose();

      boostMaterials();
      return true;
    } catch (err) {
      return false;
    }
  }

  function proceduralEnv() {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);

      const envScene = new THREE.Scene();

      const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          topColor: { value: new THREE.Color(0x2f7fd6) },
          midColor: { value: new THREE.Color(0xbfe3ff) },
          bottomColor: { value: new THREE.Color(0x8a6a42) },
          sunDir: { value: new THREE.Vector3(0.45, 0.62, 0.3).normalize() },
          sunColor: { value: new THREE.Color(0xfff2c8) }
        },
        vertexShader: [
          'varying vec3 vDir;',
          'void main(){',
          '  vDir = normalize(position);',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'varying vec3 vDir;',
          'uniform vec3 topColor;',
          'uniform vec3 midColor;',
          'uniform vec3 bottomColor;',
          'uniform vec3 sunDir;',
          'uniform vec3 sunColor;',
          'void main(){',
          '  float h = clamp(vDir.y*0.5+0.5, 0.0, 1.0);',
          '  vec3 sky = mix(midColor, topColor, pow(h,1.4));',
          '  sky = mix(bottomColor, sky, smoothstep(0.35,0.55,h));',
          '  float s = pow(max(dot(normalize(vDir), normalize(sunDir)),0.0), 220.0);',
          '  sky += sunColor * s * 6.0;',
          '  float halo = pow(max(dot(normalize(vDir), normalize(sunDir)),0.0), 12.0);',
          '  sky += sunColor * halo * 0.35;',
          '  gl_FragColor = vec4(sky,1.0);',
          '}'
        ].join('\n')
      });

      envScene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16), skyMat));

      const envRT = pmrem.fromScene(envScene, 0.07);
      scene.environment = envRT.texture;

      boostMaterials();
    } catch (err) {
      // без environment симулятор живёт дальше
    }
  }

  function loadEnv() {
    if (!THREE.RGBELoader) {
      proceduralEnv();
      return;
    }

    const loader = new THREE.RGBELoader();

    loader.load(
      'env/sky_1k.hdr',
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        if (!applyEquirect(tex)) proceduralEnv();
      },
      undefined,
      () => {
        loader.load(
          'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_puresky_1k.hdr',
          (tex) => {
            tex.mapping = THREE.EquirectangularReflectionMapping;
            if (!applyEquirect(tex)) proceduralEnv();
          },
          undefined,
          () => proceduralEnv()
        );
      }
    );
  }

  loadEnv();

  if (THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass && THREE.ShaderPass) {
    const composer = new THREE.EffectComposer(renderer);

    const renderPass = new THREE.RenderPass(scene, null);
    composer.addPass(renderPass);

    const bloom = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.34,
      0.6,
      0.85
    );
    composer.addPass(bloom);

    const baseRender = THREE.WebGLRenderer.prototype.render;
    let inComposer = false;

    renderer.render = function (s, c) {
      if (inComposer) {
        baseRender.call(renderer, s, c);
        return;
      }

      renderPass.camera = c;
      inComposer = true;
      composer.render();
      inComposer = false;
    };

    window.addEventListener('resize', () => {
      composer.setSize(window.innerWidth, window.innerHeight);
    });
  }
})();
