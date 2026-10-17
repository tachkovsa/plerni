// SPDX-License-Identifier: Apache-2.0
declare const query: { execute: <T>() => Promise<T> };
query.execute<{ id: string }>();
