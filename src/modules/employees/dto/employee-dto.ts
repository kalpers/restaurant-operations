/**
 * Purpose-specific views. There is deliberately no single employee type: each view
 * carries only what its permission allows, so a viewer can't receive restricted fields
 * the page then has to hide.
 */

/** `employees.view`. `employmentStatus` is present only for holders of `hr.view`. */
export type EmployeeDirectorySummary = {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  employmentType: string;
  primaryLocationName: string | null;
  primaryPositionName: string | null;
  employmentStatus?: string;
};

export type LocationAssignmentView = {
  id: string;
  locationId: string;
  locationName: string;
  primaryLocation: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
};

export type PositionAssignmentView = {
  id: string;
  positionId: string;
  positionName: string;
  locationId: string;
  locationName: string;
  primaryPosition: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
};

/** `employees.view`. Ended assignments are employment history and need `hr.view`. */
export type EmployeeGeneralDetail = {
  id: string;
  employeeNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredName: string | null;
  workEmail: string | null;
  hireDate: string;
  employmentType: string;
  primaryLocationId: string | null;
  version: number;
  locations: LocationAssignmentView[];
  positions: PositionAssignmentView[];
};

/** `hr.view`. */
export type EmployeeEmploymentDetail = {
  employmentStatus: string;
  terminationDate: string | null;
  version: number;
  statusHistory: {
    id: string;
    status: string;
    effectiveAt: Date;
    reason: string | null;
    changedByEmail: string;
  }[];
};

/** `hr.personal.view`. */
export type EmployeePersonalDetail = {
  personalEmail: string | null;
  phone: string | null;
  version: number;
  addresses: {
    id: string;
    addressType: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
  emergencyContacts: {
    id: string;
    name: string;
    relationship: string;
    phone: string;
    alternatePhone: string | null;
    email: string | null;
    primaryContact: boolean;
  }[];
};

/** `hr.compensation.view`. Amounts are decimal strings. */
export type EmployeePositionCompensationHistory = {
  id: string;
  positionId: string;
  positionName: string;
  compensationType: string;
  hourlyRate: string | null;
  annualSalary: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  changeReason: string | null;
}[];

/** `hr.documents.view`. Holds no storage key or filesystem path. */
export type EmployeeDocumentView = {
  id: string;
  documentType: string;
  name: string;
  description: string | null;
  mimeType: string;
  fileSize: number;
  sensitive: boolean;
  uploadedAt: Date;
};

/** `admin.users.view`. */
export type LinkedUserView = { id: string; email: string } | null;
