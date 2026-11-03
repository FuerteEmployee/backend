const express = require('express');
const router = express.Router();
const { createTicket, updateTicketStatus, getTickets, getMyTickets, deleteTicket, getCorrectionContext } = require('../controllers/ticket_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('tickets'));

// --- Support Tickets & Helpdesk ---
// checkPermission restricts sub-admins only; employees pass through it and the
// controller confines them (create: type + message or a punch correction for
// themselves; read: their own; decide/delete: refused).
router.post('/', checkPermission('tickets', 'create'), createTicket); // Raise a ticket, or a "Forgot to punch in/out" correction
router.put('/:id/status', checkPermission('tickets', 'edit'), updateTicketStatus); // Admin/Support answer a ticket
router.put('/:id', checkPermission('tickets', 'edit'), updateTicketStatus); // Alias: frontend's Approve/Reject dialog PUTs directly to /tickets/:id
router.get('/my-tickets', getMyTickets); // The logged-in employee's own tickets
router.get('/correction-context', getCorrectionContext); // Employee: the recorded punches + rules for one day, for the "Forgot to punch" form
// tickets.view: a sub-admin without it could read every employee's tickets.
router.get('/', checkPermission('tickets', 'view'), getTickets); // Tenant-wide for panel roles, own for employees
router.delete('/:id', checkPermission('tickets', 'delete'), deleteTicket); // Permanently remove a ticket

module.exports = router;
