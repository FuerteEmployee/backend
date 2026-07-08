const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://brijfuerte:brijfuerte@cluster0.5orcd9j.mongodb.net/botdb?retryWrites=true&w=majority&appName=spadb';

async function run() {
    try {
        console.log("Connecting to database...");
        await mongoose.connect(MONGO_URI);
        console.log("Connected to MongoDB database.");

        const db = mongoose.connection.db;
        const collection = db.collection('users');

        console.log("Fetching indexes on 'users' collection...");
        const indexes = await collection.indexes();
        console.log("Existing indexes:\n", JSON.stringify(indexes, null, 2));

        // Find unique indexes on adminId or adminId_1_role_1
        for (const idx of indexes) {
            const hasAdminId = idx.key && idx.key.adminId !== undefined;
            const isUnique = idx.unique === true;

            // We do not want unique indexes on adminId since multiple employees share the same adminId!
            if (hasAdminId && isUnique) {
                console.log(`Found unique index involving adminId: '${idx.name}'. Dropping it...`);
                await collection.dropIndex(idx.name);
                console.log(`Dropped index '${idx.name}' successfully.`);
            }
        }

        console.log("Syncing/Recreating correct non-unique indexes from Mongoose schema...");
        const User = require('../src/models/User');
        await User.createIndexes();
        console.log("Mongoose indexes synced successfully.");

        // Fetch indexes again to print the clean state
        const updatedIndexes = await collection.indexes();
        console.log("Updated indexes:\n", JSON.stringify(updatedIndexes, null, 2));

        console.log("Process complete. Exiting...");
        process.exit(0);
    } catch (err) {
        console.error("Error repairing indexes:", err);
        process.exit(1);
    }
}

run();
