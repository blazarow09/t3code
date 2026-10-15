const { withAppBuildGradle } = require("expo/config-plugins");

// SDK 58 registers update-resource generation even when updates.enabled is false.
// The disabled controller uses the normal RN bundle; a second Metro build is unused.
const marker = "// T3: disabled Expo updates do not need generated update resources.";

module.exports = function withDisabledAndroidUpdates(config) {
  if (config.updates?.enabled !== false) return config;
  return withAppBuildGradle(config, (next) => {
    if (next.modResults.language !== "groovy") {
      throw new Error("Disabled Android updates require a Groovy app build.gradle.");
    }
    if (!next.modResults.contents.includes(marker)) {
      next.modResults.contents += `\n${marker}\ntasks.matching {
    it.name.startsWith("create") && it.name.endsWith("UpdatesResources")
}.configureEach {
    enabled = false
}\n`;
    }
    return next;
  });
};
