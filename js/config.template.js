// ────────────────────────────────────────────────────────────────────────────
// HOA WEBSITE CONFIGURATION
// Fill in your values after completing the AWS Setup Guide.
// You will only need to edit this one file to configure the whole site.
// ────────────────────────────────────────────────────────────────────────────

const HOA_CONFIG = {

  // ── AWS COGNITO ───────────────────────────────────────────────────────────
  // Found in AWS Console → Cognito → User Pools → your pool → Overview tab
  userPoolId: '',   // e.g. us-east-1_AbC123xyz
  clientId:   '',   // e.g. 2a3b4c5d6e7f8g9h0i1j2k3l
  region:     '',   // Change if you use a different AWS region

  // ── AWS COGNITO GROUP NAMES ───────────────────────────────────────────────
  // Must exactly match the group names you create in Cognito (case-sensitive)
  boardGroup:       'board',
  homeownersGroup:  'homeowners',

  // ── DOCUMENT STORAGE (S3 + API GATEWAY) ───────────────────────────────────
  // Set up after completing the Documents Setup Guide.
  s3BucketName: '',  // e.g. hoa-documents
  s3Region:     '',  // must match where you create the bucket
  uploadApiUrl: '',  // e.g. https://abc123.execute-api.us-east-1.amazonaws.com/prod

  // ── HOA DISPLAY INFORMATION ───────────────────────────────────────────────
  // Replace with your association's actual information
  hoaName:        'Property Owners Association',
  hoaTagline:     'Building Community. Protecting Your Home.',
  hoaSubdivision: '',
  hoaCity:        '',
  hoaEmail:       'n/a',
  hoaPhone:       'n/a',
  hoaWebsite:     'www.yourHOA.org',

  // ── ANNOUNCEMENTS ───────────────────────────────────────────────────────────
  // Edit these to show current announcements on the home page.
  // Set active: false to hide an announcement.
  announcements: [
    {
      active: true,
      type:   'info',   // 'info', 'warning', or 'success'
      title:  'Welcome to the Community Portal',
      body:   'Homeowners and Board members can now access community resources online. Use the login buttons to get started.'
    },
    {
      active: false,
      type:   'warning',
      title:  'Annual Meeting — [Date]',
      body:   'The annual homeowners meeting is scheduled for [Date] at [Time] at [Location]. All homeowners are encouraged to attend.'
    },
    {
      active: false,
      type:   'success',
      title:  'Assessment Payments Due [Date]',
      body:   'Annual/quarterly assessments are due by [Date]. Contact the board if you need a payment plan.'
    }
  ],

  // ── BOARD MEMBERS (displayed on homeowner contact page) ───────────────────
  boardMembers: [
    { name: 'Jane Smith',    title: 'President',      email: 'janesmith@yahoo.com' },
    { name: 'John Green',    title: 'Vice President', email: 'johngreen@gmail.com' },
    { name: 'Jess Stone',    title: 'Sec./Treasurer', email: 'jessstone@hotmail.com' },
  ],

  // ── MANAGEMENT COMPANY (optional) ─────────────────────────────────────────
  managementCompany: {
    show:    false,   // Set to true to display management company info
    name:    '[Management Company Name]',
    phone:   '(XXX) XXX-XXXX',
    email:   '[manager@company.com]',
    website: ''
  },

  // ── EMERGENCY CONTACTS ────────────────────────────────────────────────────
  emergencyContacts: [
    { label: 'Police / Fire / Medical', number: '911' },
    { label: 'Non-Emergency', number: '311' },

  ]

};
