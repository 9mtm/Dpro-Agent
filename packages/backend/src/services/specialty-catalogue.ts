import {createHash} from 'node:crypto';

/** Approved planning catalogue. Labels are not executable instructions or tool grants. */
export const SPECIALTY_GROUPS = [
  {
    "id": "01",
    "name": "Leadership and governance",
    "entries": [
      "Chief executive",
      "Division director",
      "Board secretary",
      "Governance adviser"
    ]
  },
  {
    "id": "02",
    "name": "Strategy and business development",
    "entries": [
      "Strategy planner",
      "Business analyst",
      "Market researcher",
      "Partnership specialist",
      "Expansion specialist"
    ]
  },
  {
    "id": "03",
    "name": "Administration and offices",
    "entries": [
      "Administrative assistant",
      "Executive assistant",
      "Secretary",
      "Office manager",
      "Meeting coordinator",
      "Appointment coordinator",
      "Correspondence coordinator",
      "Business travel coordinator",
      "Decision follow-up coordinator"
    ]
  },
  {
    "id": "04",
    "name": "Projects and programmes",
    "entries": [
      "Project manager",
      "Programme manager",
      "Project coordinator",
      "Task coordinator",
      "Resource planner",
      "Change management specialist"
    ]
  },
  {
    "id": "05",
    "name": "Operations and quality",
    "entries": [
      "Operations manager",
      "Process analyst",
      "Process automation specialist",
      "Quality specialist",
      "Process auditor",
      "Continuous improvement specialist",
      "Scheduling coordinator"
    ]
  },
  {
    "id": "06",
    "name": "Finance and accounting",
    "entries": [
      "Accountant",
      "Financial controller",
      "Financial analyst",
      "Budget analyst",
      "Financial forecaster",
      "Financial reporting specialist",
      "Tax specialist",
      "Treasury specialist",
      "Invoicing specialist",
      "Collections specialist",
      "Payments coordinator",
      "Payroll specialist"
    ]
  },
  {
    "id": "07",
    "name": "Procurement and suppliers",
    "entries": [
      "Purchasing specialist",
      "Supplier researcher",
      "Supplier evaluator",
      "Supplier relationship manager",
      "Supplier contract coordinator",
      "Supplier performance analyst"
    ]
  },
  {
    "id": "08",
    "name": "Inventory and logistics",
    "entries": [
      "Inventory specialist",
      "Warehouse coordinator",
      "Demand planner",
      "Shipping coordinator",
      "Distribution planner"
    ]
  },
  {
    "id": "09",
    "name": "Human resources",
    "entries": [
      "Workforce planner",
      "Recruitment specialist",
      "Candidate screening specialist",
      "Interview coordinator",
      "People operations specialist",
      "Employment contract administrator",
      "Leave administrator",
      "Compensation and benefits specialist",
      "Performance management specialist"
    ]
  },
  {
    "id": "10",
    "name": "Employee onboarding and transitions",
    "entries": [
      "Employee onboarding specialist",
      "Internal mobility coordinator",
      "Return-to-work coordinator",
      "Offboarding specialist",
      "Employment exit coordinator",
      "Equipment and account handover coordinator"
    ]
  },
  {
    "id": "11",
    "name": "Organisational learning and development",
    "entries": [
      "Training needs analyst",
      "Course designer",
      "Staff trainer",
      "Leadership development specialist",
      "Assessment designer",
      "Skills assessor",
      "Learning progress coordinator"
    ]
  },
  {
    "id": "12",
    "name": "Employee relations and representation",
    "entries": [
      "Employee relations adviser",
      "Grievance caseworker",
      "Workplace mediator",
      "Employee representative",
      "Works council support specialist",
      "Labour rights adviser",
      "Employee-side employment lawyer"
    ]
  },
  {
    "id": "13",
    "name": "Occupational health and safety",
    "entries": [
      "Occupational physician",
      "Workplace safety specialist",
      "Occupational risk assessor",
      "Ergonomics specialist",
      "Workplace emergency coordinator"
    ]
  },
  {
    "id": "14",
    "name": "Psychological and social support",
    "entries": [
      "Work and organisational psychologist",
      "Psychologist",
      "Psychotherapist",
      "Social support counsellor",
      "Workplace stress support specialist",
      "Psychological return-to-work support specialist"
    ]
  },
  {
    "id": "15",
    "name": "Equality accessibility and integration",
    "entries": [
      "Equality and anti-discrimination specialist",
      "Disability accessibility specialist",
      "Diversity and inclusion specialist",
      "Newcomer and refugee integration adviser",
      "Integration case manager",
      "Country orientation and public services navigator",
      "Intercultural mediator",
      "Community integration coordinator"
    ]
  },
  {
    "id": "16",
    "name": "Legal services and compliance",
    "entries": [
      "Corporate lawyer",
      "Employment law specialist",
      "Contract specialist",
      "Legal research assistant",
      "Compliance specialist",
      "Policy specialist",
      "Internal investigations specialist"
    ]
  },
  {
    "id": "17",
    "name": "Regulatory intelligence and public policy",
    "entries": [
      "Government news and legislation monitor",
      "National legislation researcher",
      "EU legislation researcher",
      "Regulatory impact analyst",
      "Sector compliance specialist",
      "Obligations and deadlines coordinator",
      "Licensing coordinator",
      "Certification coordinator",
      "Public policy analyst",
      "Public affairs specialist"
    ]
  },
  {
    "id": "18",
    "name": "Audit risk and investigations",
    "entries": [
      "Internal auditor",
      "Risk analyst",
      "Independent reporting channel coordinator",
      "Investigative researcher",
      "Partner due diligence analyst",
      "Supplier risk analyst"
    ]
  },
  {
    "id": "19",
    "name": "Privacy and data protection",
    "entries": [
      "Data protection officer",
      "Privacy specialist",
      "Data access reviewer",
      "Data retention specialist"
    ]
  },
  {
    "id": "20",
    "name": "Cybersecurity",
    "entries": [
      "Endpoint security specialist",
      "Mobile device security specialist",
      "Server security specialist",
      "Network security specialist",
      "Cloud and container security specialist",
      "Application and API security specialist",
      "Data security specialist",
      "Identity and access specialist",
      "Encryption and key management specialist",
      "Vulnerability management specialist",
      "Patch management specialist",
      "Security operations analyst",
      "Cyber incident responder",
      "Digital forensics specialist",
      "Authorised penetration tester",
      "AI and agent security specialist",
      "Security awareness trainer",
      "Security auditor",
      "Chief information security officer"
    ]
  },
  {
    "id": "21",
    "name": "Internal IT and service desk",
    "entries": [
      "Employee device support technician",
      "Account administrator",
      "Internal application administrator",
      "IT asset specialist",
      "Device provisioning technician",
      "Computer maintenance technician"
    ]
  },
  {
    "id": "22",
    "name": "Systems cloud and networks",
    "entries": [
      "Systems administrator",
      "Linux administrator track",
      "Windows administrator track",
      "Web hosting administrator",
      "DNS administrator track",
      "Network administrator",
      "Cloud engineer",
      "DevOps engineer",
      "Container platform engineer",
      "Site reliability engineer",
      "Observability engineer",
      "Storage administrator",
      "Backup and recovery specialist",
      "Disaster recovery specialist"
    ]
  },
  {
    "id": "23",
    "name": "Software development",
    "entries": [
      "Frontend developer",
      "Backend developer",
      "Full-stack developer",
      "Desktop application developer",
      "Mobile developer",
      "Systems programmer",
      "Game developer",
      "Embedded and IoT developer",
      "API integration developer",
      "MCP integration developer track",
      "Automation developer",
      "Software architect",
      "QA engineer",
      "Manual testing track",
      "Test automation engineer",
      "Performance testing specialist"
    ]
  },
  {
    "id": "24",
    "name": "Data and data science",
    "entries": [
      "Data analyst",
      "Data engineer",
      "Database administrator",
      "Database developer",
      "Database performance specialist",
      "Data scientist",
      "Statistician",
      "Experimentation specialist",
      "Business intelligence specialist",
      "Analytics engineer",
      "Data quality specialist",
      "Data governance specialist",
      "Data integration specialist"
    ]
  },
  {
    "id": "25",
    "name": "Artificial intelligence",
    "entries": [
      "Machine learning engineer",
      "AI application developer",
      "Agent developer",
      "Language model specialist",
      "Computer vision specialist",
      "Speech and language technology specialist",
      "Model operations engineer",
      "Model evaluation specialist"
    ]
  },
  {
    "id": "26",
    "name": "Engineering robotics and scientific computing",
    "entries": [
      "Electronics engineer",
      "Embedded systems engineer",
      "Robotics developer",
      "Control systems engineer",
      "Scientific computing developer",
      "Simulation specialist",
      "Optimisation specialist"
    ]
  },
  {
    "id": "27",
    "name": "Science and scientific research",
    "entries": [
      "Mathematics researcher",
      "Physics researcher",
      "Chemistry researcher",
      "Biology researcher",
      "Research analysis specialist",
      "Experiment design specialist"
    ]
  },
  {
    "id": "28",
    "name": "Products and user experience",
    "entries": [
      "Product manager",
      "Digital product designer",
      "UI designer",
      "UX researcher"
    ]
  },
  {
    "id": "29",
    "name": "Education and training",
    "entries": [
      "Teacher",
      "Language teaching track",
      "Mathematics teaching track",
      "Science teaching track",
      "Programming teaching track",
      "Conversation tutor",
      "Vocational trainer",
      "Curriculum designer",
      "Learning coach",
      "Continuing education adviser",
      "Qualification and reskilling adviser",
      "Training placement coordinator",
      "Education pathways adviser",
      "Qualification pathways adviser",
      "Adult educator",
      "Education programme manager"
    ]
  },
  {
    "id": "30",
    "name": "Languages and translation",
    "entries": [
      "Translator",
      "Dialogue interpreter",
      "Community interpreter",
      "Language editor",
      "Proofreader",
      "Localisation specialist",
      "Terminology specialist",
      "Everyday and workplace language trainer"
    ]
  },
  {
    "id": "31",
    "name": "Research knowledge and technical writing",
    "entries": [
      "Research analyst",
      "Technical researcher",
      "Fact checker",
      "Technical writer",
      "Editor",
      "Knowledge management specialist",
      "Knowledge base editor"
    ]
  },
  {
    "id": "32",
    "name": "Literature and creative writing",
    "entries": [
      "Poet",
      "Novelist",
      "Short story writer",
      "Children's writer",
      "Playwright",
      "Literary editor"
    ]
  },
  {
    "id": "33",
    "name": "Songs and music",
    "entries": [
      "Lyricist",
      "Composer",
      "Music arranger",
      "Singer",
      "Instrumentalist",
      "Music producer"
    ]
  },
  {
    "id": "34",
    "name": "Acting performance and presenting",
    "entries": [
      "Actor",
      "Voice actor",
      "Dubbing performer",
      "Audiobook narrator",
      "Story narrator",
      "Presenter",
      "Comedian",
      "Virtual actor",
      "Virtual presenter",
      "Virtual character performer"
    ]
  },
  {
    "id": "35",
    "name": "Film and media production",
    "entries": [
      "Screenwriter",
      "Director",
      "Producer",
      "Cinematographer",
      "Video editor",
      "Sound editor",
      "Sound designer",
      "Visual effects specialist",
      "Podcast producer"
    ]
  },
  {
    "id": "36",
    "name": "Art design and animation",
    "entries": [
      "Graphic designer",
      "Brand designer",
      "Visual artist",
      "Illustrator",
      "Character designer",
      "3D artist",
      "Motion designer",
      "Character animator",
      "Animation specialist"
    ]
  },
  {
    "id": "37",
    "name": "Games and interactive worlds",
    "entries": [
      "Game designer",
      "Level designer",
      "Interactive narrative writer",
      "Virtual world designer",
      "Interactive experience designer",
      "Educational experience designer"
    ]
  },
  {
    "id": "38",
    "name": "Marketing advertising and content",
    "entries": [
      "Marketing strategist",
      "Brand strategist",
      "Content creator",
      "Copywriter",
      "SEO specialist",
      "Email marketing specialist",
      "Campaign specialist",
      "Growth specialist",
      "Campaign analyst",
      "Social media manager",
      "Community manager",
      "Virtual influencer"
    ]
  },
  {
    "id": "39",
    "name": "Corporate communications and public relations",
    "entries": [
      "Public relations specialist",
      "Internal communications specialist",
      "Crisis communications specialist",
      "Media relations specialist"
    ]
  },
  {
    "id": "40",
    "name": "Sales and account management",
    "entries": [
      "Prospecting specialist",
      "Lead qualification specialist",
      "Sales representative",
      "Telephone sales representative",
      "Account manager",
      "Sales operations specialist",
      "CRM specialist",
      "Proposal specialist",
      "Tender specialist"
    ]
  },
  {
    "id": "41",
    "name": "Customer service and success",
    "entries": [
      "Customer support specialist",
      "Technical support specialist",
      "Complaints specialist",
      "Customer onboarding specialist",
      "Customer trainer",
      "Customer success specialist",
      "Customer retention specialist"
    ]
  },
  {
    "id": "42",
    "name": "Contact centres",
    "entries": [
      "Inbound contact centre agent",
      "Outbound contact centre agent",
      "Appointment setter",
      "Contact centre supervisor",
      "Contact centre trainer",
      "Call quality analyst",
      "Workforce and shift planner"
    ]
  },
  {
    "id": "43",
    "name": "E-commerce",
    "entries": [
      "Online store manager",
      "Product catalogue specialist",
      "Product listing specialist",
      "Order coordinator",
      "Purchase experience specialist"
    ]
  },
  {
    "id": "44",
    "name": "Real estate architecture and spatial design",
    "entries": [
      "Real estate coordinator",
      "Property manager",
      "Lettings coordinator",
      "Property maintenance coordinator",
      "Architectural designer",
      "Interior designer",
      "Landscape designer",
      "Building information modelling specialist"
    ]
  },
  {
    "id": "45",
    "name": "Facilities assets and physical security",
    "entries": [
      "Facilities manager",
      "Receptionist",
      "Asset inventory specialist",
      "Equipment coordinator",
      "Maintenance contract coordinator",
      "Site security specialist"
    ]
  },
  {
    "id": "46",
    "name": "Manufacturing production and maintenance",
    "entries": [
      "Production planner",
      "Industrial quality specialist",
      "Maintenance planner",
      "Fault analysis specialist"
    ]
  },
  {
    "id": "47",
    "name": "Tourism and hospitality",
    "entries": [
      "Travel planner",
      "Reservations coordinator",
      "Hotel receptionist",
      "Guest services specialist",
      "Hotel operations manager"
    ]
  },
  {
    "id": "48",
    "name": "Events",
    "entries": [
      "Event planner",
      "Participant coordinator",
      "Event programme coordinator",
      "Event equipment coordinator"
    ]
  },
  {
    "id": "49",
    "name": "Health nutrition fitness and habits",
    "entries": [
      "Health information and education specialist",
      "Nutrition specialist",
      "Fitness coach",
      "Strength training coach track",
      "Mobility coach track",
      "Yoga coach track",
      "Activity coach",
      "Habits coach"
    ]
  },
  {
    "id": "50",
    "name": "Agriculture environment and sustainability",
    "entries": [
      "Agriculture specialist",
      "Natural resources specialist",
      "Environmental analyst",
      "Sustainability specialist",
      "Corporate social responsibility specialist"
    ]
  },
  {
    "id": "51",
    "name": "Community services and nonprofit organisations",
    "entries": [
      "Volunteer coordinator",
      "Grant writer",
      "Community programme manager",
      "Social worker",
      "Social case manager",
      "Family support adviser",
      "Youth support adviser",
      "Housing services navigator",
      "Health services navigator",
      "Education services navigator",
      "Community health worker"
    ]
  },
  {
    "id": "52",
    "name": "Personal assistance and organisation",
    "entries": [
      "Personal assistant",
      "Personal scheduling assistant",
      "Task organisation assistant",
      "Personal planning assistant"
    ]
  },
  {
    "id": "53",
    "name": "Documents records and archives",
    "entries": [
      "Document controller",
      "Document approval coordinator",
      "Version control coordinator",
      "Archivist",
      "Records retention specialist"
    ]
  },
  {
    "id": "54",
    "name": "Insurance and claims",
    "entries": [
      "Insurance policy coordinator",
      "Insurance renewal coordinator",
      "Claims coordinator"
    ]
  },
  {
    "id": "55",
    "name": "Business continuity and crises",
    "entries": [
      "Business continuity planner",
      "Crisis coordinator",
      "Business interruption planner",
      "Recovery planner",
      "Preparedness exercise coordinator"
    ]
  },
  {
    "id": "56",
    "name": "International operations and branches",
    "entries": [
      "Branch coordinator",
      "Country operations coordinator",
      "Multilingual operations coordinator",
      "Multi-currency operations coordinator",
      "Local requirements coordinator"
    ]
  },
  {
    "id": "57",
    "name": "Career guidance and employment services",
    "entries": [
      "Career guidance adviser",
      "Job search adviser",
      "Employment placement specialist",
      "Job application coach",
      "CV and cover letter coach",
      "Interview coach",
      "Skills and experience assessor",
      "Qualification recognition adviser",
      "Apprenticeship coordinator",
      "Vocational placement coordinator",
      "Labour market return adviser",
      "Supported employment specialist",
      "Employer liaison",
      "Youth coach",
      "Employment assistance specialist",
      "Vocational training assistance specialist",
      "On-the-job coach",
      "Employer inclusion support coordinator"
    ]
  },
  {
    "id": "58",
    "name": "Coaching mentoring and professional supervision",
    "entries": [
      "Life and personal development coach",
      "Career transition coach",
      "Executive coach",
      "Leadership coach",
      "Team coach",
      "Learning and study organisation coach",
      "Communication coach",
      "Presentation and public speaking coach",
      "Habits and time management coach",
      "Mentor",
      "Professional supervisor"
    ]
  },
  {
    "id": "59",
    "name": "Care family and community support",
    "entries": [
      "Older adult care specialist",
      "Disability support specialist",
      "Childcare specialist",
      "Early years educator",
      "Youth worker",
      "Family support worker",
      "Care services coordinator",
      "Community outreach worker"
    ]
  },
  {
    "id": "60",
    "name": "Healthcare rehabilitation and medical services",
    "entries": [
      "Nurse",
      "Midwife",
      "Medical assistant",
      "Medical laboratory specialist",
      "Rehabilitation specialist",
      "Physiotherapist",
      "Occupational therapist",
      "Pharmacist",
      "Medical practitioner",
      "Health services manager",
      "Community health navigator"
    ]
  },
  {
    "id": "61",
    "name": "Food culinary services and food safety",
    "entries": [
      "Chef",
      "Baker",
      "Food production specialist",
      "Food safety specialist",
      "Food quality specialist",
      "Restaurant manager",
      "Food service specialist"
    ]
  },
  {
    "id": "62",
    "name": "Construction building services and trades",
    "entries": [
      "Construction planner",
      "Civil engineering specialist",
      "Electrician",
      "Plumbing specialist",
      "Heating specialist",
      "Ventilation and air conditioning specialist",
      "Carpenter",
      "Construction trades specialist",
      "Interior finishing specialist",
      "Building services technician"
    ]
  },
  {
    "id": "63",
    "name": "Industrial engineering materials and vehicle services",
    "entries": [
      "Mechanical engineer",
      "Machinery specialist",
      "Vehicle technician",
      "Metalworking specialist",
      "Chemical process specialist",
      "Biotechnology specialist",
      "Plastics specialist",
      "Glass specialist",
      "Ceramics specialist",
      "Stone materials specialist",
      "Raw materials specialist",
      "Mining specialist"
    ]
  },
  {
    "id": "64",
    "name": "Telecommunications electrical systems and measurement",
    "entries": [
      "Telecommunications specialist",
      "Industrial electronics specialist",
      "Measurement and instrumentation specialist",
      "Electrical systems specialist",
      "Industrial automation specialist",
      "Electromechanical specialist"
    ]
  },
  {
    "id": "65",
    "name": "Transport and mobility",
    "entries": [
      "Road transport specialist",
      "Driver",
      "Rail operations specialist",
      "Aviation operations specialist",
      "Maritime operations specialist",
      "Passenger transport coordinator",
      "Transport planner",
      "Fleet coordinator"
    ]
  },
  {
    "id": "66",
    "name": "Forestry horticulture animals and veterinary services",
    "entries": [
      "Forestry specialist",
      "Horticulture specialist",
      "Livestock specialist",
      "Animal care specialist",
      "Fisheries specialist",
      "Veterinary professional",
      "Wildlife and habitat specialist"
    ]
  },
  {
    "id": "67",
    "name": "Fashion textiles crafts and publishing production",
    "entries": [
      "Fashion designer",
      "Tailor",
      "Textile specialist",
      "Leatherwork specialist",
      "Jewellery designer",
      "Craft specialist",
      "Printing specialist",
      "Prepress specialist",
      "Publishing production specialist"
    ]
  },
  {
    "id": "68",
    "name": "Cleaning beauty and personal services",
    "entries": [
      "Specialist cleaner",
      "Building caretaker",
      "Personal care service specialist",
      "Hair stylist",
      "Beauty specialist",
      "Cosmetics specialist"
    ]
  },
  {
    "id": "69",
    "name": "Energy utilities and environmental technology",
    "entries": [
      "Renewable energy specialist",
      "Energy systems specialist",
      "Environmental technology specialist",
      "Water systems specialist",
      "Waste and recycling specialist"
    ]
  },
  {
    "id": "70",
    "name": "Culture humanities libraries and heritage",
    "entries": [
      "Historian",
      "Philosopher",
      "Sociologist",
      "Cultural researcher",
      "Librarian",
      "Museum specialist",
      "Heritage specialist",
      "Cultural programme coordinator",
      "Spiritual care and chaplaincy specialist",
      "Funeral services coordinator"
    ]
  },
  {
    "id": "71",
    "name": "Public services emergency and community safety",
    "entries": [
      "Public service navigator",
      "Public administration specialist",
      "Emergency response planner",
      "Community safety specialist",
      "Public protection researcher"
    ]
  },
  {
    "id": "72",
    "name": "Banking and financial services",
    "entries": [
      "Banking operations specialist",
      "Credit analyst",
      "Financial services adviser",
      "Insurance operations specialist"
    ]
  }
] as const;

const key=(name:string)=>name.trim().toLowerCase().replace(/\s+/g,' ');
const idFor=(name:string)=>{const h=createHash('sha256').update('specialty-planned-v1:'+key(name)).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
export const PLANNED_SPECIALTIES=(()=>{
 const entries=new Map<string,{id:string;name:string;department:string;groups:string[];kind:'role'|'track';planned:true;revision:0;description:string;agents:never[]}>();
 for(const group of SPECIALTY_GROUPS)for(const name of group.entries){const k=key(name),existing=entries.get(k);if(existing){if(!existing.groups.includes(group.name))existing.groups.push(group.name);continue;}entries.set(k,{id:idFor(name),name,department:group.name,groups:[group.name],kind:name.endsWith(' track')?'track':'role',planned:true,revision:0,description:'Coming soon · instructions, skills and requirements are being prepared.',agents:[]});}
 return [...entries.values()];
})();
export const plannedSpecialty=(id:string)=>PLANNED_SPECIALTIES.find(item=>item.id===id);
export const SPECIALTY_DEPARTMENT_GROUPS:Record<string,string>={development:'Software development',infrastructure:'Systems cloud and networks',security:'Cybersecurity',data:'Data and data science',education:'Education and training',marketing:'Marketing advertising and content',design:'Art design and animation',production:'Film and media production',wellness:'Health nutrition fitness and habits',sales:'Sales and account management',support:'Customer service and success',finance:'Finance and accounting',operations:'Operations and quality',hr:'Human resources',research:'Research knowledge and technical writing',legal:'Legal services and compliance'};
export function extendSpecialtyList<T extends {id:string;name:string;department:string}>(existing:T[]){
 const names=new Set(existing.map(item=>key(item.name)));
 return [...existing.map(item=>{const match=PLANNED_SPECIALTIES.find(p=>key(p.name)===key(item.name));return {...item,planned:false,...(match?{groups:match.groups,kind:match.kind}:{groups:[SPECIALTY_DEPARTMENT_GROUPS[item.department]??item.department],kind:'role' as const})};}),...PLANNED_SPECIALTIES.filter(item=>!names.has(key(item.name)))];
}
