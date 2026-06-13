const fs = require('fs');
const path = require('path');
const routesDir = path.join(__dirname, 'src/routes');
const files = fs.readdirSync(routesDir);
let routes = {};

const routeMap = {
    "user_routes.js": "/api/users",
    "department_routes.js": "/api/departments",
    "branch_routes.js": "/api/branches",
    "attendance_routes.js": "/api/attendance",
    "salary_routes.js": "/api/salary",
    "ticket_routes.js": "/api/tickets",
    "shift_routes.js": "/api/shifts",
    "tracking_routes.js": "/api/tracking",
    "dashboard_routes.js": "/api/dashboard",
    "leave_type_routes.js": "/api/leave-types",
    "festival_routes.js": "/api/festivals",
    "expense_routes.js": "/api/expenses",
    "asset_routes.js": "/api/assets",
    "asset_category_routes.js": "/api/asset-categories",
    "announcement_routes.js": "/api/announcements",
    "lead_routes.js": "/api/leads",
    "settings_routes.js": "/api/settings",
    "leave_routes.js": "/api/leaves"
};

files.forEach(file => {
    if (!routeMap[file]) return;
    const basePath = routeMap[file];
    const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const regex = /router\.(get|post|put|patch|delete)\(['"](.*?)['"]/g;
    let match;
    routes[file] = { basePath, endpoints: [] };
    while ((match = regex.exec(content)) !== null) {
        routes[file].endpoints.push({
            method: match[1].toUpperCase(),
            path: match[2]
        });
    }
});

console.log(JSON.stringify(routes, null, 2));


