// ─────────────────────────────────────────────────────────────────────────────
// HOA WEBSITE CONFIGURATION
// Fill in your values after completing the AWS Setup Guide.
// You will only need to edit this one file to configure the whole site.
// ─────────────────────────────────────────────────────────────────────────────

const HOA_CONFIG = {

  // ── AWS COGNITO ─────────────────────────────────────────────────────────────
  // Found in AWS Console → Cognito → User Pools → your pool → Overview tab
  userPoolId: 'us-east-1_tfk0ub8lC',   // e.g. us-east-1_AbC123xyz
  clientId:   '787l9oam57h8nv74i5gdf7i6b',  // e.g. 2a3b4c5d6e7f8g9h0i1j2k3l
  region:     'us-east-1',                        // Change if you use a different AWS region

  // ── COGNITO GROUP NAMES ─────────────────────────────────────────────────────
  // Must exactly match the group names you create in Cognito (case-sensitive)
  boardGroup:       'board',
  homeownersGroup:  'homeowners',

  // ── DOCUMENT STORAGE (S3 + API GATEWAY) ────────────────────────────────────
  // Set up after completing the Documents Setup Guide.
  s3BucketName: 'hoa-documents-mmpoaii',                                  // e.g. hoa-documents-mmpoaii
  s3Region:     'us-east-1',                                              // must match where you create the bucket
  uploadApiUrl: 'https://vbttai9kma.execute-api.us-east-1.amazonaws.com', // e.g. https://abc123.execute-api.us-east-1.amazonaws.com/prod

  // ── FINANCIAL REPORTS API ──────────────────────────────────────────────────
  // API Gateway endpoint that returns the account balance PDF
  financialReportApiUrl: 'https://604iprtdt1.execute-api.us-east-1.amazonaws.com/prod/financial/account-balance',

  // ── DOCUMENT REVIEW API ───────────────────────────────────────────────────
  // API Gateway endpoint for the governing document review system
  reviewApiUrl: 'https://21pqepa0sc.execute-api.us-east-1.amazonaws.com/prod',

  // ── COGNITO REVIEW GROUP NAMES ─────────────────────────────────────────────
  reviewersGroup:    'reviewers',
  reviewAdminsGroup: 'review-admins',



  // ── HOA DISPLAY INFORMATION ─────────────────────────────────────────────────
  // Replace with your association's actual information
  hoaName:        'Meadow Mountain Property Owners Association II',
  hoaShortName:   'MMPOAII',
  hoaTagline:     'Building Community. Protecting Your Home.',
  hoaSubdivision: 'Meadow Mountain Phase II',
  hoaCity:        'Austin, TX 78731',
  hoaEmail:       'n/a',
  hoaPhone:       'n/a',
  hoaWebsite:     'www.mmpoaii.org',

  // ── ANNOUNCEMENTS ───────────────────────────────────────────────────────────
  // Edit these to show current announcements on the home page.
  // Set active: false to hide an announcement.
  announcements: [
    {
      active: true,
      type:   'info',   // 'info', 'warning', or 'success'
      title:  'Welcome to the MMPOAII-A Community Portal',
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

  // ── BOARD MEMBERS (displayed on homeowner contact page) ─────────────────────
  boardMembers: [
    { name: 'Dale Emanuel',    title: 'President',  email: 'dale83152@yahoo.com' },
    { name: 'Gene Willard',    title: 'Vice President', email: 'deargenewillard@gmail.com' },
    { name: 'Dave Weilert',    title: 'Sec./Treasurer',  email: 'daveweilert@gmail.com' },
  ],

  // ── MANAGEMENT COMPANY (optional) ───────────────────────────────────────────
  managementCompany: {
    show:    false,   // Set to true to display management company info
    name:    '[Management Company Name]',
    phone:   '(XXX) XXX-XXXX',
    email:   '[manager@company.com]',
    website: ''
  },

  // ── EMERGENCY CONTACTS ──────────────────────────────────────────────────────
  emergencyContacts: [
    { label: 'Police / Fire / Medical', number: '911' },
    { label: 'Non-Emergency', number: '311' },
  ]

};
