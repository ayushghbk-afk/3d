import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { PostFxSettings } from '../state/models.js';

/** Vignette + film grain + a cheap depth-of-field-ish blur, one pass. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.35 },
    uGrain: { value: 0.08 },
    uDof: { value: 0 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uDof;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec4 color = texture2D(tDiffuse, uv);

      // fake depth of field: blur the frame edges with a 5-tap kernel
      if (uDof > 0.001) {
        float edge = smoothstep(0.28, 0.62, length(uv - 0.5));
        float amount = uDof * edge * 0.006;
        vec4 blurred = texture2D(tDiffuse, uv) * 0.36;
        blurred += texture2D(tDiffuse, uv + vec2(amount, 0.0)) * 0.16;
        blurred += texture2D(tDiffuse, uv - vec2(amount, 0.0)) * 0.16;
        blurred += texture2D(tDiffuse, uv + vec2(0.0, amount)) * 0.16;
        blurred += texture2D(tDiffuse, uv - vec2(0.0, amount)) * 0.16;
        color = mix(color, blurred, clamp(edge * uDof * 2.0, 0.0, 1.0));
      }

      // vignette
      float d = distance(uv, vec2(0.5));
      float vig = smoothstep(0.85, 0.28, d * (1.0 + uVignette));
      color.rgb *= mix(1.0, vig, clamp(uVignette, 0.0, 1.0));

      // grain
      if (uGrain > 0.001) {
        float n = rand(uv * uResolution + fract(uTime) * 100.0) - 0.5;
        color.rgb += n * uGrain * 0.35;
      }

      gl_FragColor = color;
    }
  `,
};

/**
 * Optional post-processing chain: bloom → grade (vignette/grain/DoF) → output.
 * Only constructed when the project enables it, keeping the default path a
 * single `renderer.render` call.
 */
export class PostFx {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private output: OutputPass;
  private cfg: PostFxSettings;
  private time = 0;
  enabled = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    cfg: PostFxSettings,
  ) {
    this.cfg = { ...cfg };
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.cfg.bloom, 0.6, 0.85);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
    this.configure(cfg);
  }

  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.grade.uniforms.uResolution.value.set(w, h);
  }

  configure(cfg: PostFxSettings): void {
    this.cfg = { ...cfg };
    this.bloom.enabled = cfg.bloom > 0.001;
    this.bloom.strength = cfg.bloom;
    this.grade.uniforms.uVignette.value = cfg.vignette;
    this.grade.uniforms.uGrain.value = cfg.grain;
    this.grade.uniforms.uDof.value = cfg.dof;
  }

  render(dt = 0.016): void {
    this.time += dt;
    this.grade.uniforms.uTime.value = this.time;
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.setRenderTarget(null);
  }
}
