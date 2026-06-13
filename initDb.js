require('dotenv').config();
const mongoose = require('mongoose');

async function initDb() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB.');
    
    // Create a dummy collection and insert a document to force DB creation
    const Schema = mongoose.Schema;
    const DummySchema = new Schema({ name: String });
    const DummyModel = mongoose.model('DummyInit', DummySchema);
    
    await DummyModel.create({ name: 'Init Database' });
    console.log('Successfully inserted a dummy document. The database should now be visible.');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exit(1);
  }
}

initDb();
