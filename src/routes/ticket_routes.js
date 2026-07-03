const express = require('express');
const router = express.Router();
const { createTicket, updateTicketStatus, getTickets, getMyTickets } = require('../controllers/ticket_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('tickets'));

// --- Support Tickets & Helpdesk ---
router.post('/', checkPermission('tickets', 'create'), createTicket); // Raise a new support or IT ticket (employees pass through)
router.put('/:id/status', checkPermission('tickets', 'edit'), updateTicketStatus); // Admin/Support update ticket progress (Open, Pending, Resolved)
router.put('/:id', checkPermission('tickets', 'edit'), updateTicketStatus); // Alias: frontend's Approve/Reject dialog PUTs directly to /tickets/:id
router.get('/my-tickets', getMyTickets); // View list of tickets for logged in employee
router.get('/', getTickets); // View list of tickets (user-specific or admin-wide)

module.exports = router;
