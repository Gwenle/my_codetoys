#include <iostream>
#include <conio.h>
#include <cstdlib>
#include <Windows.h>
#include <cstring>
#include <vector>
#include <ctime>
#include <cstdlib>
using std::cout;
using std::endl;
using std::pair;
typedef pair<int, int> pp;
bool space[15][24];
int ans = 0;
void gotoxy(int x, int y) 
{
	COORD pos;
	pos.X = x;
	pos.Y = y;
	SetConsoleCursorPosition(GetStdHandle(STD_OUTPUT_HANDLE), pos);
}
void back_print()
{
	for (int f = 18; f >= 0; f--)
	{
		gotoxy(11, f + 4);
		for (int p = 0; p < 12; p++)
			cout << ((space[p][f]) ? "#" : " ");
	}
	gotoxy(36, 10);
	cout << "              ";
	gotoxy(36, 10);
	cout << ans;

}
void clk()
{
	bool ftk[15][24];
	memset(ftk, 0, sizeof(ftk));
	int o = 18;
	for (int k = 18; k >= 0; k--)
	{
		bool ck = true;//�������ı�־
		for (int j = 0; j < 12; j++)
		{
			if (space[j][k] == false)
				ck = false;
		}
		if (ck != true)
		{
			for (int p = 0; p < 12; p++)
				ftk[p][o] = space[p][k];
			o--;
		}
		else
			ans = ans + 100;
	}
	std::swap(space, ftk);
	back_print();
}
void background()
{
	gotoxy(10, 3);
	cout << "**************";
	for (int i = 1; i <= 20; i++)
	{
		gotoxy(10, 3+i);
		cout << "*";
	    gotoxy(23, 3+i);
		cout << "*";
	}
	gotoxy(10, 23);
	cout << "**************";
	cout << endl;
	gotoxy(27, 10);
	cout << "��Ϸ�÷�:"<<ans;
	gotoxy(27, 15);
	cout << "����˵����ʹ��ASD���Ʒ���W���任��״";
	gotoxy(27, 17);
}
class shape
{
	friend bool fall(shape& cha);
public:
	shape(pp a, pp b, pp c, pp d);
	virtual ~shape() {}
	void s_print(bool t=true)
	{
		for (int i = 0; i < 4; i++)
		{
			int x = po[i].first;
			int y = po[i].second;
			gotoxy(11+x, y+4);
			cout <<( (t)? "#" : " ");
		}
	}
	bool move(int i)
	{
		//i==1���� 2���� 3����
		int x1=0, y1=0;
		switch (i)
		{
		case 1:
			x1 = -1;
			y1 = 0;
			break;
		case 2:
			x1 = 1;
			y1 = 0;
			break;
		case 3:
			x1 = 0;
			y1 = 1;
			break;
		}
		bool rm = true;//�����ƶ��ı�־
		int fk[2][4];//0 x 1 y
		for(int j=0;j<4;j++)
		{
			fk[0][j] = x1 + po[j].first;
			fk[1][j] = y1 + po[j].second;
			if (fk[0][j] < 0 || fk[0][j]>11 || 
				fk[1][j]<0||fk[1][j]>18||
				space[fk[0][j]][fk[1][j]] == true)
				rm = false;
      	}
		if (!rm)
		{
			return false;
		}
		else
		{
			s_print(false);
			for (int j = 0; j < 4; j++)
			{
				po[j].first = fk[0][j];
				po[j].second = fk[1][j];
			}
			s_print();
		}
		return true;
	}
	virtual bool distortion();
protected:
	pair<int, int> po[4];//x,y
};
shape::shape(pp a, pp b, pp c, pp d)
{
	po[0] = a;
	po[1] = b;
	po[2] = c;
	po[3] = d;
}
//shape��������po[2]
bool shape::distortion()
{
	int x1 = 0, y1 = 0;
	bool rm = true;//�����ƶ��ı�־
	int fk[2][4];//0 x 1 y
	for (int j = 0; j < 4; j++)
	{
		x1 = po[j].first - po[2].first;
		y1 = po[j].second - po[2].second;
		int x2 = y1;
		int y2 = -x1;
		fk[0][j] = x2 + po[2].first;
		fk[1][j] = y2 + po[2].second;
		if (fk[0][j] < 0 || fk[0][j]>11 || 
			fk[1][j]<0||fk[1][j]>18||
			space[fk[0][j]][fk[1][j]] == true)
		    rm = false;
	}
	if (!rm)
	{
			return false;
	}
	else
	{
		s_print(false);
		for (int j = 0; j < 4; j++)
		{
				po[j].first = fk[0][j];
				po[j].second = fk[1][j];
		}
		s_print();
	}
	return true;
}
class fangkuai : public shape
{
public:
	fangkuai(pp a, pp b, pp c, pp d) :shape(a, b, c, d) {}
	bool distortion() override
	{
		return true;
	}
};
//����״��ͼ�α���ģʽ��Ҫ���⴦��
class changtiao : public shape 
{
public:
	changtiao(pp a, pp b, pp c, pp d) :shape(a, b, c, d),bianx(false) {}
	bool distortion() override
	{
		if (bianx == false)
		{
			if (shape::distortion() == true)
				bianx = true;
		}
		else
		{
			int x1 = 0, y1 = 0;
			bool rm = true;//�����ƶ��ı�־
			int fk[2][4];//0 x 1 y
			for (int j = 0; j < 4; j++)
			{
				x1 = po[j].first - po[2].first;//!!
				y1 = po[j].second - po[2].second;//!!
				int x2 = -y1;
				int y2 = x1;
				fk[0][j] = x2 + po[2].first;
				fk[1][j] = y2 + po[2].second;
				if (fk[0][j] < 0 || fk[0][j]>11 ||
					fk[1][j] < 0 || fk[1][j]>18 ||
					space[fk[0][j]][fk[1][j]] == true)
					rm = false;
			}
			if (!rm)
			{
				return false;
			}
			else
			{
				s_print(false);
				for (int j = 0; j < 4; j++)
				{
					po[j].first = fk[0][j];
					po[j].second = fk[1][j];
				}
				s_print();
				bianx = false;
			}
		}
	}
private:
	bool bianx;
};
//����һ����ͼ�ε���ת���������й��ԣ�����ת������Ϊ�麯��
bool fall(shape& cha)
{
	for (int j = 0; j < 4; j++)
		if (space[cha.po[j].first][cha.po[j].second] == true)
			return false;
	auto show = [](shape& g)
	{
		g.s_print();
		char f;
		int c = 0;
		f = getch();
		switch (f)
		{
		case 'A':
		case 'a':
			c = 1;
			break;
		case 'S':
		case 's':
			c = 3;
			break;
		case 'D':
		case 'd':
			c = 2;
			break;
		}
		g.move(c);
		if (f == 'W' || f == 'w')
			g.distortion();
	};
	cha.s_print();
	while (true)//�ⲿ�ֿ����Զ�����
	{
		auto st = [&]()
		{
			if (kbhit() != 0)
				show(cha);
			Sleep(100);
		};
		//ԭ�ȵİ汾��ֱ��sleep(1000)���������ڼ�������Ӧ
		//�����뵽�����ֳַ�10������������ʱ�䲻��ķ���
		for (int j = 0; j < 10; j++)
			st();
		//char ft = getch();
		if (cha.move(3) == false)
		{
			for (int i = 0; i < 4; i++)
				space[cha.po[i].first][cha.po[i].second] = true;
			break;
		}
	}
	clk();
	return true;
}
int main()
{
	CONSOLE_CURSOR_INFO cci;
	cci.bVisible = FALSE;
	cci.dwSize = sizeof(cci);
	HANDLE handle = GetStdHandle(STD_OUTPUT_HANDLE);
	SetConsoleCursorInfo(handle, &cci);
	//����windows api���ع��
	background();
	//background��ӡ
	std::vector<shape> ve;
	ve.push_back(shape(pp(5, 0), pp(4, 1), pp(5, 1), pp(6, 1)));
	ve.push_back(shape(pp(4, 2), pp(5, 1), pp(4, 1), pp(5, 0)));
	ve.push_back(shape(pp(4,0), pp(4,1), pp(5,0), pp(6,0)));
	ve.push_back(shape(pp(6, 1), pp(4, 0), pp(5, 0), pp(6, 0)));
	fangkuai fa(pp(5, 0), pp(6, 0), pp(5, 1), pp(6, 1));
	changtiao ct(pp(5, 0), pp(5, 1), pp(5, 2), pp(5, 3));
	
	srand(time(0));//���������
	bool gt = true;//gameover�ı�־
	do
	{
		int k = rand() % 6;
		if (k < 4)
		{
			shape* t = new shape(ve[k]);
			gt=fall(*t);
			delete t;
		}
		else if (k == 4)
		{
			shape* t = new fangkuai(fa);
			gt=fall(*t);
			delete t;
		}
		else
		{
			shape* t = new changtiao(ct);
			gt = fall(*t);
			delete t;
		}
	} while (gt == true);
	//the end
	system("cls");
	gotoxy(0, 9);
	cout << "���յ÷�:" <<ans<< endl;
	cout << "       gameover!!"<<endl;
	cout << endl;
	system("pause");
	return 0;
}

//��Ϊ������̫��winapi����ÿ����Ҫcls����������������ȫ�������ĸо�
//��������������һ��apiд�������ƶ����