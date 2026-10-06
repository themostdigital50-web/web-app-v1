export default function requireRole(...roles) {
  return function authorizeRole(request, response, next) {
    if (!request.session?.user) {
      return response.status(401).json({ message: "Please log in to continue." });
    }

    if (!roles.includes(request.session.user.role)) {
      return response.status(403).json({ message: "You do not have permission to do that." });
    }

    next();
  };
}