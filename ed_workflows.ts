// Example workflow functions for testing the dashboard

export async function orderWorkflow(orderId: string, customerId: string): Promise<{ status: string }> {
  // Access tools from global scope (injected by dashboard validation)
  const g = global as any
  
  // Call tool functions - these will be auto-recorded by the wrapper
  if (typeof g.fetchUserData === 'function') {
    const userData = await g.fetchUserData(customerId)
    console.log('[orderWorkflow] Fetched user:', userData)
  }
  
  if (typeof g.validateEmail === 'function' && customerId.includes('@')) {
    const isValid = g.validateEmail(customerId)
    console.log('[orderWorkflow] Email valid:', isValid)
  }
  
  if (typeof g.calculateDiscount === 'function') {
    const discountedPrice = g.calculateDiscount(100, 10)
    console.log('[orderWorkflow] Discounted price:', discountedPrice)
  }
  
  if (typeof g.sendNotification === 'function') {
    const notification = await g.sendNotification(customerId, `Order ${orderId} confirmed`)
    console.log('[orderWorkflow] Notification sent:', notification)
  }
  
  return { status: 'completed', orderId, customerId }
}

export async function refundWorkflow(orderId: string): Promise<void> {
  // Simulate refund processing
}

export function getUserStatus(userId: string): string {
  // Synchronous user status check
  return 'active'
}

export async function checkoutFlow(cartId: string, paymentMethod: string): Promise<{ orderId: string }> {
  // Simulate checkout flow
  return { orderId: 'order-123' }
}

export function validateOrder(orderData: any): boolean {
  // Synchronous validation
  return true
}
