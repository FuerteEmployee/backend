// Version comparison for the OTA update check (app_release_controller.checkForUpdate).
//
// Why this exists. The update check decides with `versionName === release.version`
// and nothing else, so a phone on ANY other version is offered the newest enabled
// release, even when that release is OLDER than what the phone already runs.
//
// A phone that has not downloaded an update reports its APK's own versionName as its
// bundle version. So a fresh 1.9.6 APK was told "you are on 1.9.6, the newest is
// pilot 1.9.5", downloaded 1.9.5, and quietly replaced the new web layer it shipped
// with by last week's. Seen live from the emulator on 2026-09-30
// ("on 1.9.6 -> offering 1.9.5 (pilot)", afterwards bundle=1.9.5 on APK 1.9.6).
//
// The rule is deliberately narrow: never offer a release older than the APK's OWN
// version. It does NOT forbid offering an older bundle to a phone that is running a
// downloaded newer one, because that is how a rollback works (disable the bad release
// and phones fall back to the previous one -- OPERATIONS.md section 9).

/** "1.9.6", "v1.9.6", "1.9.6-staging" -> [1, 9, 6]. null when there is no leading number. */
function parseVersion(value) {
    const m = /^\s*v?(\d+(?:\.\d+)*)/.exec(String(value == null ? '' : value));
    return m ? m[1].split('.').map(Number) : null;
}

/** Numeric, segment by segment: negative when a < b, 0 when equal, positive when a > b. */
function compareVersions(a, b) {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Is `releaseVersion` older than the version of the APK asking?
 *
 * False whenever either side has no readable number ("builtin", "unknown", missing):
 * with nothing to compare, the caller keeps its old behaviour and offers the release.
 */
function isOlderThanApk(releaseVersion, apkVersionName) {
    const release = parseVersion(releaseVersion);
    const apk = parseVersion(apkVersionName);
    if (!release || !apk) return false;
    return compareVersions(release, apk) < 0;
}

module.exports = { parseVersion, compareVersions, isOlderThanApk };
