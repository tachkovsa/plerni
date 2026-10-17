// SPDX-License-Identifier: Apache-2.0
declare const query: { $assertType: <T>() => T };
query.$assertType<{ id: string }>();
