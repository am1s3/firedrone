(function () {
  'use strict';

  if (typeof THREE === 'undefined' || !window.SIM) return;

  const A = {
    ctx: null,
    master: null,

    buffers: {},

    motorSynthGain: null,
    motorOscs: [],
    buzzOsc: null,
    buzzGain: null,

    motorAssetSrc: null,
    motorAssetGain: null,

    windSynthGain: null,
    windAssetSrc: null,
    windAssetGain: null,

    init() {
      if (this.ctx) return;

      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();

        this.master = this.ctx.createDynamicsCompressor();
        this.master.threshold.setValueAtTime(-18, this.ctx.currentTime);
        this.master.knee.setValueAtTime(20, this.ctx.currentTime);
        this.master.ratio.setValueAtTime(8, this.ctx.currentTime);
        this.master.attack.setValueAtTime(0.003, this.ctx.currentTime);
        this.master.release.setValueAtTime(0.12, this.ctx.currentTime);
        this.master.connect(this.ctx.destination);

        this.buildMotorSynth();
        this.buildWindSynth();
        this.loadAssets();
      } catch (err) {
        this.ctx = null;
      }
    },

    buildMotorSynth() {
      const ctx = this.ctx;

      const motorFilter = ctx.createBiquadFilter();
      motorFilter.type = 'lowpass';
      motorFilter.frequency.value = 760;
      motorFilter.Q.value = 0.85;

      this.motorSynthGain = ctx.createGain();
      this.motorSynthGain.gain.value = 0;

      const types = ['sawtooth', 'square', 'triangle'];
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        osc.type = types[i];
        osc.frequency.value = 70;
        osc.connect(motorFilter);
        osc.start();
        this.motorOscs.push(osc);
      }

      motorFilter.connect(this.motorSynthGain);
      this.motorSynthGain.connect(this.master);

      this.buzzOsc = ctx.createOscillator();
      this.buzzOsc.type = 'sawtooth';
      this.buzzOsc.frequency.value = 210;

      this.buzzGain = ctx.createGain();
      this.buzzGain.gain.value = 0;

      const buzzFilter = ctx.createBiquadFilter();
      buzzFilter.type = 'bandpass';
      buzzFilter.frequency.value = 1400;
      buzzFilter.Q.value = 1.4;

      this.buzzOsc.connect(buzzFilter);
      buzzFilter.connect(this.buzzGain);
      this.buzzGain.connect(this.master);
      this.buzzOsc.start();
    },

    buildWindSynth() {
      const ctx = this.ctx;

      const len = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buffer.getChannelData(0);

      for (let i = 0; i < len; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;

      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 460;
      windFilter.Q.value = 0.42;

      this.windSynthGain = ctx.createGain();
      this.windSynthGain.gain.value = 0;

      noise.connect(windFilter);
      windFilter.connect(this.windSynthGain);
      this.windSynthGain.connect(this.master);
      noise.start();
    },

    loadAssets() {
      const self = this;

      this.loadBuffer('sounds/motor.mp3', (buf) => {
        self.startLoopAsset(buf, 'motor');
      });

      this.loadBuffer('sounds/wind.mp3', (buf) => {
        self.startLoopAsset(buf, 'wind');
      });

      this.loadBuffer('sounds/explosion.mp3', (buf) => {
        self.buffers.explosion = buf;
      });
    },

    loadBuffer(url, cb) {
      const self = this;

      fetch(url, { mode: 'same-origin' })
        .then((r) => {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.arrayBuffer();
        })
        .then((ab) => self.ctx.decodeAudioData(ab))
        .then(cb)
        .catch(() => {});
    },

    startLoopAsset(buffer, kind) {
      const ctx = this.ctx;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      src.connect(gain);
      gain.connect(this.master);
      src.start();

      if (kind === 'motor') {
        this.motorAssetSrc = src;
        this.motorAssetGain = gain;
      } else if (kind === 'wind') {
        this.windAssetSrc = src;
        this.windAssetGain = gain;
      }
    },

    playOneShot(buffer, rate, vol) {
      if (!this.ctx || !buffer) return;

      const ctx = this.ctx;
      const t = ctx.currentTime;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + Math.max(0.4, buffer.duration / rate));

      src.connect(gain);
      gain.connect(this.master);

      src.start(t);
    },

    explosion() {
      if (this.buffers.explosion) {
        this.playOneShot(this.buffers.explosion, 0.85 + Math.random() * 0.3, 0.95);
      }
    },

    update() {
      if (!this.ctx) return;

      const st = SIM.state;
      const t = this.ctx.currentTime;

      const running = st.armed && !st.crashed;

      if (running) {
        const base = 68 + st.motor * 290 + Math.random() * 8;
        const mults = [1, 2.02, 3.07];

        for (let i = 0; i < this.motorOscs.length; i++) {
          this.motorOscs[i].frequency.setTargetAtTime(base * mults[i] + i * 3, t, 0.03);
        }

        this.motorSynthGain.gain.setTargetAtTime(0.012 + st.motor * 0.085, t, 0.05);

        this.buzzOsc.frequency.setTargetAtTime(180 + st.motor * 900, t, 0.04);
        this.buzzGain.gain.setTargetAtTime(st.motor * 0.05, t, 0.06);
      } else {
        this.motorSynthGain.gain.setTargetAtTime(0, t, 0.12);
        this.buzzGain.gain.setTargetAtTime(0, t, 0.12);
      }

      if (this.motorAssetSrc && this.motorAssetGain) {
        const rate = 0.55 + st.motor * 1.05 + Math.random() * 0.02;
        this.motorAssetSrc.playbackRate.setTargetAtTime(rate, t, 0.06);
        this.motorAssetGain.gain.setTargetAtTime(running ? 0.12 + st.motor * 0.5 : 0, t, 0.08);
      }

      const speed = st.vel.length();

      if (this.windSynthGain) {
        this.windSynthGain.gain.setTargetAtTime(SIM.utils.clamp(speed * 0.004, 0, 0.055), t, 0.1);
      }

      if (this.windAssetSrc && this.windAssetGain) {
        this.windAssetGain.gain.setTargetAtTime(SIM.utils.clamp(speed * 0.006, 0, 0.09), t, 0.12);
      }
    },

    beep(freq, dur, vol, type) {
      if (!this.ctx) return;

      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();

      o.type = type || 'sine';
      o.frequency.value = freq;

      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);

      o.connect(g);
      g.connect(this.master);

      o.start();
      o.stop(ctx.currentTime + dur + 0.02);
    },

    gateBeep() {
      this.beep(880, 0.14, 0.1, 'sine');
    },

    lapBeep() {
      this.beep(1320, 0.3, 0.12, 'sine');
      setTimeout(() => this.beep(1760, 0.22, 0.09, 'sine'), 90);
    },

    crashSound() {
      this.beep(64, 0.55, 0.2, 'sawtooth');
      this.beep(38, 0.8, 0.16, 'triangle');
      this.explosion();
    },

    uiBeep() {
      this.beep(520, 0.08, 0.05, 'square');
    }
  };

  SIM.audio = A;
})();
