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
                //
                // DISABLE_SCHEDULER exists for developer machines pointed at a
                // SHARED database. These jobs write: closeForgottenPunches()
                // punches people out for yesterday. A laptop running against
                // staging would do that a second time, concurrently with the
                // real server and possibly from half-edited code. Set it in any
                // .env that is not the machine that owns the deployment.
                if (String(process.env.DISABLE_SCHEDULER).toLowerCase() === 'true') {
                    console.log('[scheduler] disabled via DISABLE_SCHEDULER -- no jobs registered');
                } else {
                    startScheduler();
                }
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
