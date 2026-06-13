const Ticket = require('../models/Ticket');
const Subscription = require('../models/Subscription');

exports.createTicket = async (req, res) => {
    try {
        // Check ticket monthly limit
        if (req.adminId) {
            const subscription = await Subscription.findOne({ adminId: req.adminId }).populate('planId');
            if (subscription && subscription.planId) {
                const limitVal = subscription.planId.modules?.get('tickets') || subscription.planId.modules?.['tickets'];
                if (limitVal && limitVal.includes('50')) {
                    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
                    const currentCount = await Ticket.countDocuments({
                        adminId: req.adminId,
                        createdAt: { $gte: startOfMonth }
                    });
                    if (currentCount >= 50) {
                        return res.status(400).json({
                            message: `Ticket monthly limit reached (maximum 50 tickets per month allowed on your plan). Please upgrade your plan to raise more.`
                        });
                    }
                }
            }
        }

        const ticket = await Ticket.create({ 
            ...req.body, 
            adminId: req.adminId,
            employeeId: req.userId 
        });
        res.status(201).json(ticket);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateTicketStatus = async (req, res) => {
    try {
        const { status, adminRemark } = req.body;
        const ticket = await Ticket.findOneAndUpdate(
            { _id: req.params.id, adminId: req.adminId },
            { status, adminRemark },
            { new: true }
        );
        if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
        res.json(ticket);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.getTickets = async (req, res) => {
    try {
        let query = { adminId: req.adminId };
        
        // If employee, only show their own tickets. If admin, show all for this tenant.
        if (req.user && req.user.role === 'employee') {
            query.employeeId = req.userId;
        }

        const tickets = await Ticket.find(query)
            .populate('employeeId', 'name')
            .sort({ createdAt: -1 });
        res.json(tickets);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getMyTickets = async (req, res) => {
    try {
        const tickets = await Ticket.find({ 
            adminId: req.adminId, 
            employeeId: req.userId 
        })
        .populate('employeeId', 'name')
        .sort({ createdAt: -1 });
        res.json(tickets);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
