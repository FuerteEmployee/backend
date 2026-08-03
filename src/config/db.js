const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        if (!process.env.MONGO_URI) {
            console.error("CRITICAL: MONGO_URI environment variable is missing!");
            process.exit(1);
        }
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`MongoDB Connected`);

        // Clean up a historical bad index: a UNIQUE index on adminId *alone*,
        // which would allow only one user per tenant.
        //
        // Scoped deliberately to single-key adminId indexes. An earlier version
        // dropped any unique index merely *containing* adminId, which silently
        // destroyed the intentional compound unique index on
        // { adminId, deviceUserId } (one biometric PIN per employee per company)
        // on every single boot. Do not widen this condition again — compound
        // unique indexes starting with adminId are legitimate and expected.
        const db = mongoose.connection.db;
        const collection = db.collection('users');
        const indexes = await collection.indexes();
        for (const idx of indexes) {
            const keys = Object.keys(idx.key || {});
            const isAdminIdOnly = keys.length === 1 && keys[0] === 'adminId';
            if (isAdminIdOnly && idx.unique === true) {
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
