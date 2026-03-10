import { useState, useEffect, useMemo } from 'react';

export const useAuth = () => {
    // Memoize to prevent new object reference on every render
    // which would cause useEffect([session]) to loop infinitely
    const session = useMemo(() => ({
        user: { id: 'local-user', email: 'local@user.com' }
    } as any), []);

    const profile = useMemo(() => ({
        role: 'admin', subscription_tier: 'pro'
    }), []);

    const signOut = useMemo(() => () => Promise.resolve(), []);

    return {
        session,
        profile,
        isPro: true,
        isAdmin: true,
        subscriptionExpired: false,
        loading: false,
        signOut
    };
};
