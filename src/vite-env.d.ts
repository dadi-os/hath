/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly HATH_TARGET?: string;
  readonly DIMAAG_URL?: string;
  readonly YAAD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
