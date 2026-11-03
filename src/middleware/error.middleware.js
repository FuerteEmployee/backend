const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }
    // Prefer the status carried by the error itself (body-parser sets 413 for
    // oversized payloads, 400 for malformed JSON) over a generic 500.
    const statusCode = err.status || err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
    res.status(statusCode).json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
};

const notFound = (req, res, next) => {
    const error = new Error(`Not Found - ${req.originalUrl}`);
    res.status(404);
    next(error);
};

module.exports = { errorHandler, notFound };
