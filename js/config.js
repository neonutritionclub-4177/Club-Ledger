const config = Object.freeze({
  clubName: 'Salem Turning Point Nutrition Club',
  lowShakes: 2,
  expiringSoonDays: 3,
  supabase: {
    url: import.meta.env.VITE_SUPABASE_URL || '',
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || ''
  },
  packTypes: [
    { id: '6-day', label: '6-day', totalShakes: 6, price: 0, durationDays: 6 },
    { id: '12-day', label: '12-day', totalShakes: 12, price: 0, durationDays: 12 },
    { id: '26-day', label: '26-day', totalShakes: 26, price: 0, durationDays: 26 },
    { id: 'custom', label: 'Custom', totalShakes: 30, price: 0, durationDays: 30 }
  ]
});

export default config;
