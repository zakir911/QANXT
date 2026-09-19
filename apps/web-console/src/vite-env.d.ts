/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the control plane lives. Set at build time or by the container's entrypoint. */
  readonly VITE_API_URL?: string;
  readonly VITE_PRODUCT_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
