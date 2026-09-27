"use strict";

// The single registration list used by desktop and Pocket. Plugin metadata
// and behavior belong to each entry, not to the Library widget.
const loadPlugins = async () => {
  for (const [folder, css] of [["palette", true], ["story-map", true], ["note-cards", true], ["sprints", true], ["github-backup"], ["spellcheck"]]) {
    if (css) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `plugins/${folder}/styles.css`;
      document.head.appendChild(link);
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `plugins/${folder}/index.js`;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load plugin ${folder}`));
      document.head.appendChild(script);
    }).catch((error) => reportError(error.message));
  }
};
