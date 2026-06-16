require("dotenv").config();
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const connectDB = require("./config/db");
const app = require("./app");
const { startScheduler } = require("./jobs/scheduler");

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
        console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);

        // Connect to Database in background
        connectDB()
            .then(() => {
                // Long-running host (local / PM2 / EC2): run scheduled jobs in-process.
                // On Vercel serverless the same jobs run via /api/cron instead.
                startScheduler();
            })
            .catch(err => {
                console.error("Failed to connect to database:", err);
            });
    });
} else {
    // In Vercel, connect DB immediately
    connectDB().catch(err => console.error("DB connection error:", err));
}

module.exports = app;
