const express = require("express");
const cors = require("cors");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

// Body parser
app.use(express.json());

// Enable CORS
const allowedOrigins = [
    "https://botcrm.beontimeofficial.com",
    "https://gray-crab-756474.hostingersite.com",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:4173",
    "https://api.beontimeofficial.com",

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
app.use("/api/salary", require("./routes/salary_routes"));
app.use("/api/tickets", require("./routes/ticket_routes"));
app.use("/api/shifts", require("./routes/shift_routes"));
app.use("/api/tracking", require("./routes/tracking_routes"));
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
app.use("/api/superadmin", require("./routes/superadmin_routes"));

// Base route
app.get("/", (req, res) => {
    res.send("HRMS API is running...");
});

// Error handling
app.use(notFound);
app.use(errorHandler);

module.exports = app;


