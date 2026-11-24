/**
 * Identity of this fork's desktop app (see NOTICE.md). Kept out of main.cjs so upstream merges stay small.
 *  - PRODUCT_NAME also names the profile folder: ~/Library/Application Support/<PRODUCT_NAME>.
 *  - UPDATES_ENABLED false: the in-app updater never loads. It would replace this build with the official app;
 *    updates come from merging upstream releases instead.
 */
module.exports = { PRODUCT_NAME: "Lernwerk", UPDATES_ENABLED: false };
