-- =====================================================
-- FIX RLS POLICIES FOR CARTS (work with anon key)
-- Run this in Supabase SQL Editor
-- =====================================================

-- Drop existing cart policies
DROP POLICY IF EXISTS "Users can manage their own cart" ON carts;
DROP POLICY IF EXISTS "Users can manage their own cart items" ON cart_items;

-- Better policies for carts (using auth.uid() directly)
CREATE POLICY "Users can manage their own cart" ON carts
    FOR ALL USING (
        auth.uid() = user_id 
        OR (user_id IS NULL AND session_id IS NOT NULL)
    );

CREATE POLICY "Users can manage their own cart items" ON cart_items
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM carts 
            WHERE carts.id = cart_items.cart_id 
            AND (carts.user_id = auth.uid() OR (carts.user_id IS NULL AND carts.session_id IS NOT NULL))
        )
    );

-- Also fix orders policies to work better
DROP POLICY IF EXISTS "Users can create their own orders" ON orders;
CREATE POLICY "Users can create their own orders" ON orders
    FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- Verify
SELECT 'Cart RLS policies updated' as status;