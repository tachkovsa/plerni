// NEGATIVE FIXTURE — must trip the kernel-purity gate. Not part of any build.
// Whole-word violation in this comment: assigning a course to an employee.
// (camelCase identifiers like assignCourseToEmployee evade word boundaries by design.)
export function assignCourseToEmployee(courseId: string, employeeId: string) {
  return { courseId, employeeId };
}
