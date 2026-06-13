const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        if (!process.env.MONGO_URI) {
            console.error("CRITICAL: MONGO_URI environment variable is missing!");
            process.exit(1);
        }
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`MongoDB Connected`);
    } catch (error) {
        console.error(`Database Connection Error: ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
};

module.exports = connectDB;
