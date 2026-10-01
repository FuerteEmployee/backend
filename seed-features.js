const mongoose = require('mongoose');
require('dotenv').config();
const PlanFeature = require('./src/models/PlanFeature');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to DB');
    
    const defaultFeatures = [
      { key: "attendance", label: "Attendance & leave", type: "boolean", order: 1 },
      { key: "salary", label: "Salary & payroll", type: "select", options: ["none", "basic", "full pf/esic/pt", "full + custom", "full + api"], order: 2 },
      { key: "branchesDepts", label: "Branches & depts", type: "select", options: ["none", "2", "10", "50", "unlimited"], order: 3 },
      { key: "shifts", label: "Shift management", type: "select", options: ["none", "2 shifts", "unlimited"], order: 4 },
      { key: "holidays", label: "Festivals & holidays", type: "boolean", order: 5 },
      { key: "tickets", label: "Helpdesk tickets", type: "select", options: ["none", "50/mo", "unlimited"], order: 6 },
      { key: "gpsTracking", label: "GPS tracking", type: "boolean", order: 7 },
      { key: "assets", label: "Assets management", type: "boolean", order: 8 },
      { key: "expenses", label: "Expense management", type: "boolean", order: 9 },
      { key: "noticeBoard", label: "Notice board", type: "boolean", order: 10 },
      { key: "leads", label: "Lead management", type: "boolean", order: 11 },
      { key: "customBranding", label: "Custom branding", type: "boolean", order: 12 },
      { key: "prioritySupport", label: "Dedicated support", type: "boolean", order: 13 }
    ];
    // Deliberately absent: geminiAI, analytics, firebaseNotifications,
    // apiAccess, whatsappAlerts. None has any code behind it (no AI calls, no
    // tenant analytics, no push/WhatsApp provider, no tenant API keys), so
    // listing them sold plans on features that do not exist. The deactivate
    // step below hides them; re-add a row here only once the feature ships.

    // Deactivate old features not in the new list to keep database clean
    const activeKeys = defaultFeatures.map(f => f.key);
    await PlanFeature.updateMany({ key: { $nin: activeKeys } }, { $set: { isActive: false } });

    // Upsert the new feature set
    for (const f of defaultFeatures) {
      await PlanFeature.updateOne({ key: f.key }, { $set: { ...f, isActive: true } }, { upsert: true });
    }

    console.log('Seeded PlanFeatures from strategy list!');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

seed();
