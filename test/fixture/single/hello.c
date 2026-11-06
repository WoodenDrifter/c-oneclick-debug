#include <stdio.h>

static int add(int a, int b); /* 前向声明 */

// 程序入口
int main(void)
{
    int s = add(3, 4);
    printf("sum = %d\n", s);
    return 0;
}

static int add(int a, int b)
{
    return a + b;
}
