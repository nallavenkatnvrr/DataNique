/**
 * Visual effects level. "auto" turns on light effects when the browser has no
 * graphics acceleration (software WebGL renderer: SwiftShader, llvmpipe,
 * "Microsoft Basic Render Driver" — typical for virtual desktops and remote
 * sessions), where shadows and transitions make the UI feel slow.
 */
export type EffectsPref = "auto" | "full" | "lite";
const KEY = "dv-effects";

let detected: { lite: boolean; renderer: string } | null = null;

export function detectRenderer(): { lite: boolean; renderer: string } {
  if (detected) return detected;
  let renderer = "";
  let lite = false;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl") || c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) {
      lite = true;
      renderer = "no WebGL";
    } else {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      lite = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* keep full effects */
  }
  detected = { lite, renderer };
  return detected;
}

export function getEffectsPref(): EffectsPref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "full" || v === "lite" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function applyEffects(pref: EffectsPref = getEffectsPref()): boolean {
  const lite = pref === "lite" || (pref === "auto" && detectRenderer().lite);
  document.documentElement.classList.toggle("dv-lite", lite);
  return lite;
}

export function setEffectsPref(pref: EffectsPref): boolean {
  try {
    if (pref === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  return applyEffects(pref);
}
