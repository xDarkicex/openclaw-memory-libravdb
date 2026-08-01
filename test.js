const wm = new WeakMap();
const arr = [1, 2, 3];
wm.set(arr, "hello");
console.log(wm.get(arr));
