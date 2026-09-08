/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_GITHUB_CLIENT_ID?: string;
  readonly VITE_APP_NAME?: string;
  readonly VITE_AI_ASSISTANT_URL?: string;
  readonly VITE_AI_ASSISTANT_KEY?: string;
  readonly VITE_AI_ASSISTANT_MODEL?: string;
  readonly VITE_AI_IMAGE_URL?: string;
  readonly VITE_AI_IMAGE_KEY?: string;
  readonly VITE_AI_IMAGE_MODEL?: string;
  readonly VITE_AI_3D_URL?: string;
  readonly VITE_AI_3D_KEY?: string;
  readonly VITE_AI_3D_MODEL?: string;
  readonly VITE_AI_SF3D_SPACE?: string;
  readonly VITE_AI_TRIPOSR_SPACE?: string;
  readonly VITE_HF_TOKEN?: string;
  readonly VITE_AGENT_RELAY_URL?: string;
}
