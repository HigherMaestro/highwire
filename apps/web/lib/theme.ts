export const THEME_KEY = "hw-theme";

/** Runs before paint so a saved theme doesn't flash. Kept tiny and dependency-free. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
