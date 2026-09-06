/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly HATH_TARGET?: string;
  readonly HATH_TSNET?: string;
  readonly HATH_CONTROL_URL?: string;
  readonly DIMAAG_URL?: string;
  readonly YAAD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
