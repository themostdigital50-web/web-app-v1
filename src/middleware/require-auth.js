export default function requireAuth(request, response, next){
    const user = request.session?.user;

    if(!user?.id || !user?.tenantId){
        return response.status(401).json({
            message: 'Please log in to continue'
        });
    }

    next();
}