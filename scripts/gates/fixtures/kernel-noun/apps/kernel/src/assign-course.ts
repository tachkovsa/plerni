// NEGATIVE FIXTURE — must trip the kernel-purity gate. Not part of any build.
export function assignCourseToEmployee(courseId: string, employeeId: string) {
  return { courseId, employeeId };
}
