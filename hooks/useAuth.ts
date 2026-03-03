import { useState, useEffect } from 'react';

export const useAuth = () => {
    return {
        session: { user: { id: 'local-user', email: 'local@user.com' } } as any,
        profile: { role: 'admin', subscription_tier: 'pro' },
        isPro: true,
        isAdmin: true,
        subscriptionExpired: false,
        loading: false,
        signOut: () => Promise.resolve()
    };
};
