const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        if (!process.env.MONGO_URI) {
            console.error("CRITICAL: MONGO_URI environment variable is missing!");
            process.exit(1);
        }
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`MongoDB Connected`);

        // Check and drop incorrect unique index on adminId
        const db = mongoose.connection.db;
        const collection = db.collection('users');
        const indexes = await collection.indexes();
        for (const idx of indexes) {
            const hasAdminId = idx.key && idx.key.adminId !== undefined;
            const isUnique = idx.unique === true;
            if (hasAdminId && isUnique) {
                console.log(`[DB Setup] Dropping incorrect unique index: ${idx.name}`);
                await collection.dropIndex(idx.name);
                console.log(`[DB Setup] Unique index ${idx.name} dropped successfully.`);
            }
        }
    } catch (error) {
        console.error(`Database Connection Error: ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
};

module.exports = connectDB;
