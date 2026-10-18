interface ImportMetaEnv {
  /** injected by scenes-plugin/vite.config.mts from SCENES_SERVER_URL */
  VITE_APP_SCENES_SERVER_URL: string;
  /** injected from SCENES_GIT_REPO / SCENES_GIT_BRANCH */
  VITE_APP_SCENES_GIT_REPO: string;
  VITE_APP_SCENES_GIT_BRANCH: string;
}
