const express = require("express");
const cors = require("cors");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

// Body parser
app.use(express.json());

// Enable CORS
const allowedOrigins = [
    "https://botcrm.beontimeofficial.com",
    // Staging web + its own API. These lived ONLY on the staging server for a
    // while, added by hand and never committed, so the first source deploy that
    // overwrote app.js silently removed them and every login from
    // staging.beontimeofficial.com failed CORS preflight. Keeping them here is
    // what stops that happening again -- an origin the product genuinely uses
    // belongs in the repo, not in one machine's working copy.
    "https://staging.beontimeofficial.com",
    "https://staging-api.beontimeofficial.com",
    "https://gray-crab-756474.hostingersite.com",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:4173",
    "https://api.beontimeofficial.com",

    // BOTLens (camera attendance app) — integration disabled, origins closed off
    // "http://localhost:8000",
    // "https://localhost:8000",
    // "http://localhost:10000",
    // "https://localhost:10000",
    // "https://botlens.beontimeofficial.com",

    // Capacitor native apps (Android/iOS WebView origins)
    "https://localhost",
    "http://localhost",
    "capacitor://localhost",
    "ionic://localhost",
];

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error(`CORS blocked: ${origin}`));
        },
        credentials: true,
    }),
);

// Mount routers
app.use("/api/users", require("./routes/user_routes"));
app.use("/api/departments", require("./routes/department_routes"));
app.use("/api/branches", require("./routes/branch_routes"));
app.use("/api/attendance", require("./routes/attendance_routes"));
// app.use("/api/device/attendance", require("./routes/device_attendance_routes"));
// Company-admin view of their own biometric machines (read + rename only).
app.use("/api/devices", require("./routes/device_routes"));
// Biometric devices (eSSL/ZKTeco ADMS protocol) hit /iclock/* directly at the
// domain root — the path is hardcoded in device firmware, not configurable.
app.use("/iclock", require("./routes/iclock_routes"));
app.use("/api/salary", require("./routes/salary_routes"));
app.use("/api/advance-salary", require("./routes/advanceSalary"));
app.use("/api/tickets", require("./routes/ticket_routes"));
app.use("/api/shifts", require("./routes/shift_routes"));
app.use("/api/tracking", require("./routes/tracking_routes"));
app.use("/api/geofence", require("./routes/geofence_routes"));
app.use("/api/dashboard", require("./routes/dashboard_routes"));
app.use("/api/leave-types", require("./routes/leave_type_routes"));
app.use("/api/festivals", require("./routes/festival_routes"));
app.use("/api/expenses", require("./routes/expense_routes"));
app.use("/api/assets", require("./routes/asset_routes"));
app.use("/api/asset-categories", require("./routes/asset_category_routes"));
app.use("/api/announcements", require("./routes/announcement_routes"));
app.use("/api/leads", require("./routes/lead_routes"));
app.use("/api/settings", require("./routes/settings_routes"));
app.use("/api/leaves", require("./routes/leave_routes"));
app.use("/api/regularizations", require("./routes/regularization_routes"));
app.use("/api/superadmin", require("./routes/superadmin_routes"));
app.use("/api/cron", require("./routes/cron_routes"));
app.use("/api/client", require("./routes/client_routes"));
app.use("/api/app", require("./routes/app_release_routes"));

// Over-the-air bundle downloads. Served straight off disk because they are
// immutable, public, and a few megabytes — putting them behind Express auth
// would break the pre-login update check that exists to rescue a broken build.
// `immutable` is safe: a new bundle always gets a new filename.
app.use(
    "/bundles",
    express.static(require("path").join(__dirname, "..", "bundles"), {
        maxAge: "1y",
        immutable: true,
        fallthrough: false,
    }),
);

// Signed APKs, on the same terms as bundles and for the same reasons: public,
// immutable (the filename carries the versionCode), and reachable without a
// session because the system browser — not the app — performs the download,
// and it carries none of the app's headers.
app.use(
    "/apks",
    express.static(require("path").join(__dirname, "..", "apks"), {
        maxAge: "1y",
        immutable: true,
        fallthrough: false,
        setHeaders: (res) => {
            // Android's download manager decides what to do with a file from
            // its Content-Type. Served as the default octet-stream some devices
            // save it as a text file, which then cannot be installed.
            res.setHeader("Content-Type", "application/vnd.android.package-archive");
        },
    }),
);

// Base route
app.get("/", (req, res) => {
    res.send("HRMS API is running...");
});

// Error handling
app.use(notFound);
app.use(errorHandler);

module.exports = app;


