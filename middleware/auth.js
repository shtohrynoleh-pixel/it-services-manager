// Authentication & Authorization middleware

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'company_admin')) return next();
  return res.redirect('/login');
}

function requireCompanyAccess(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  const user = req.session.user;
  const companyId = parseInt(req.params.companyId || req.params.cid || req.query.company_id || req.body.company_id);

  // Super admin can access any company
  if (user.is_super) return next();
  if (user.role === 'admin') return next();

  // Company admin — check assigned companies
  if (user.assignedCompanies && user.assignedCompanies.includes(companyId)) return next();

  // Client can only access their own company
  if (user.company_id && user.company_id === companyId) return next();

  return res.status(403).send('Access denied');
}

// Role-based access — checks against a list of allowed roles
// Usage: requireRole('fuel_admin', 'fuel_manager')
function requireRole(...roles) {
  return function(req, res, next) {
    if (!req.session || !req.session.user) return res.redirect('/login');
    const user = req.session.user;

    // Super admin bypasses all role checks
    if (user.is_super) return next();

    // Check if user has any of the required roles
    const userRoles = user.roles || [];
    if (user.role === 'admin') userRoles.push('admin');

    // Admin role grants all fuel roles
    if (user.role === 'admin' || user.role === 'company_admin') return next();

    if (roles.some(r => userRoles.includes(r))) return next();

    return res.status(403).send('Access denied — requires role: ' + roles.join(' or '));
  };
}

// Company-scoped role check — combines company access + role
function requireCompanyRole(...roles) {
  return function(req, res, next) {
    requireCompanyAccess(req, res, (err) => {
      if (err) return;
      requireRole(...roles)(req, res, next);
    });
  };
}

module.exports = { requireLogin, requireAdmin, requireCompanyAccess, requireRole, requireCompanyRole };
